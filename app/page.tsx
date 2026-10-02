"use client";

import { useEffect, useState } from "react";
import { App as AntApp, Badge, Button, Card, Descriptions, Form, Input, InputNumber, Modal, Select, Segmented, Space, Statistic, Table, Tag, Timeline } from "antd";
import { format } from "date-fns";
import { useForm, Controller } from "react-hook-form";
import { z } from "zod";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import type { ColumnsType } from "antd/es/table";
import { fetchStations } from "../lib/query";
import { MapPanel } from "../components/MapPanel";
import { REQUIRED_APPROVERS, useIncidentStore, type PendingAction, type PlanStatus, type Role, type ShuttlePlan, type Station, type StationStatus } from "../store/incident";

const planSchema = z.object({ stations: z.array(z.string()).min(1, "至少选择两个接驳站"), vehicles: z.number().min(1).max(80), interval: z.number().min(2).max(30), operator: z.string().min(2), note: z.string().min(2) });
type PlanForm = z.infer<typeof planSchema>;

const planStatusColor: Record<PlanStatus, string> = { 草稿: "default", 待确认: "orange", 已确认: "green", 已执行: "green", 未达标: "red", 已失效: "default" };

function Dashboard() {
  const t = useTranslations();
  const { message } = AntApp.useApp();
  const queryClient = useQueryClient();
  const state = useIncidentStore();
  const { data: cachedStations } = useQuery({ queryKey: ["stations"], queryFn: fetchStations, enabled: state.online });
  const [modalOpen, setModalOpen] = useState(false);
  const [executeTarget, setExecuteTarget] = useState<ShuttlePlan | null>(null);
  const [actualVehicles, setActualVehicles] = useState(0);
  const [actualInterval, setActualInterval] = useState(0);
  const [panel, setPanel] = useState<string>("总览");
  const { control, handleSubmit, reset, formState: { errors } } = useForm<PlanForm>({ defaultValues: { stations: ["滨江站", "会展中心站"], vehicles: 8, interval: 6, operator: "东城公交", note: "优先疏运站外滞留乘客" } });

  useEffect(() => { if (!state.online) queryClient.cancelQueries({ queryKey: ["stations"] }); }, [state.online, queryClient]);

  // 回网后自动同步本地队列：按计划编号去重，失败的留在队列里重试
  useEffect(() => {
    if (!state.online || state.pendingActions.length === 0) return;
    const result = state.syncActions();
    if (result.remaining > 0) message.warning(`本地队列已按计划编号去重同步，${result.remaining} 条失败留待重试`);
    else if (result.synced > 0) message.success(`本地队列已同步 ${result.synced} 条`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.online]);

  const stationColumns: ColumnsType<Station> = [
    { title: "车站", dataIndex: "name" },
    { title: "区段", dataIndex: "section" },
    { title: "状态", dataIndex: "status", render: (value: StationStatus) => <Tag color={value === "封闭" ? "red" : value === "限流" ? "orange" : value === "恢复中" ? "blue" : "green"}>{value}</Tag> },
    { title: "滞留风险", dataIndex: "passengerRisk", render: (value) => <Badge status={value === "高" ? "error" : value === "中" ? "warning" : "success"} text={value} /> },
    { title: "现场说明", dataIndex: "note" },
    { title: "更新时间", dataIndex: "updatedAt", render: (value: string) => format(new Date(value), "HH:mm:ss") },
    { title: "处置", render: (_, record) => <Space><Button size="small" disabled={state.role === "客服主管"} onClick={() => state.setStationStatus(record.id, "限流")}>限流</Button><Button size="small" disabled={state.role === "客服主管"} danger={record.status !== "封闭"} onClick={() => state.setStationStatus(record.id, record.status === "封闭" ? "恢复中" : "封闭")}>{record.status === "封闭" ? "恢复中" : "封闭"}</Button></Space> }
  ];

  const handleApprove = (plan: ShuttlePlan) => {
    const result = state.approvePlan(plan.id, state.role);
    if (!result.ok) message.error(result.reason);
    else if (result.queued) message.info(result.reason);
    else if (result.duplicate) message.warning("同一岗位重复确认只计一次");
    else if (result.status === "已确认") message.success("调度员与公交接驳负责人会签完成，计划已确认");
    else message.success("已会签，等待另一岗位确认");
  };

  const openExecute = (plan: ShuttlePlan) => { setExecuteTarget(plan); setActualVehicles(plan.vehicles); setActualInterval(plan.interval); };

  const confirmExecute = () => {
    if (!executeTarget) return;
    const result = state.executePlan(executeTarget.id, { vehicles: actualVehicles, interval: actualInterval });
    if (!result.ok) message.error(result.reason);
    else if (result.status === "未达标") message.warning("实际到场少于计划，已标记为未达标");
    else message.success("计划已执行，实际到场与计划对账达标");
    setExecuteTarget(null);
  };

  const handleSync = () => {
    const result = state.syncActions();
    if (result.remaining > 0) message.warning(`已同步 ${result.synced} 条，${result.remaining} 条失败留待重试`);
    else message.success(`已同步 ${result.synced} 条本地操作`);
  };

  const planColumns: ColumnsType<ShuttlePlan> = [
    { title: "接驳站", dataIndex: "stations", render: (value: string[]) => value.join(" → ") },
    { title: "计划车辆", dataIndex: "vehicles", render: (value: number) => `${value} 辆` },
    { title: "计划间隔", dataIndex: "interval", render: (value: number) => `${value} 分钟` },
    { title: "实际对账", render: (_, record) => record.actualVehicles != null ? <Space size={4}><span>{record.actualVehicles} 辆 / {record.actualInterval ?? "—"} 分钟</span>{record.status === "未达标" && <Tag color="red">未达标</Tag>}</Space> : "—" },
    { title: "运营方", dataIndex: "operator" },
    { title: "会签", dataIndex: "approvals", render: (approvals: Role[]) => REQUIRED_APPROVERS.map((role) => <Tag key={role} color={approvals.includes(role) ? "green" : "default"}>{role} {approvals.includes(role) ? "✓" : "✗"}</Tag>) },
    { title: "状态", dataIndex: "status", render: (value: PlanStatus) => <Tag color={planStatusColor[value]}>{value}</Tag> },
    { title: "操作", render: (_, record) => <Space><Button size="small" disabled={record.status !== "草稿"} onClick={() => state.submitPlan(record.id)}>提交确认</Button><Button size="small" disabled={record.status !== "待确认"} onClick={() => handleApprove(record)}>确认</Button><Button size="small" type="primary" disabled={record.status !== "已确认"} onClick={() => openExecute(record)}>执行</Button></Space> }
  ];

  const queueColumns: ColumnsType<PendingAction> = [
    { title: "动作", dataIndex: "action" },
    { title: "内容", dataIndex: "detail" },
    { title: "入队时间", dataIndex: "time", render: (value: string) => format(new Date(value), "HH:mm:ss") },
    { title: "已重试", dataIndex: "attempts", render: (value: number) => `${value} 次` },
    { title: "最近错误", dataIndex: "lastError", render: (value?: string) => value ?? "—" }
  ];

  const submitPlan = (values: PlanForm) => { const parsed = planSchema.safeParse(values); if (!parsed.success) return; state.addPlan(parsed.data); setModalOpen(false); reset(); };

  return <div className="shell">
    <aside className="side">
      <div className="brand"><b>RAIL OPS</b><span>应急协同</span></div>
      <nav>{["总览", "事件时间线", "接驳计划", "确认中心"].map((item) => <button className={panel === item ? "active" : ""} key={item} onClick={() => setPanel(item)}>{item}</button>)}</nav>
      <div className="side-status"><small>系统连接</small><b className={state.online ? "ok" : "warn"}>{state.online ? "在线" : "弱网降级"}</b><span>最近缓存 32 秒前</span></div>
    </aside>
    <main>
      <header><div><small>{state.incident.id} · 启动于 {format(new Date(state.incident.startedAt), "HH:mm")}</small><h1>{t("title")}</h1><p>{t("subtitle")}</p></div><Space><Segmented value={state.online} onChange={(value) => state.setOnline(Boolean(value))} options={[{ label: "在线", value: true }, { label: "弱网", value: false }]} /><Select<Role> value={state.role} onChange={state.setRole} options={["调度员", "车站值班员", "公交接驳负责人", "客服主管"].map((value) => ({ value: value as Role, label: `角色：${value}` }))} /></Space></header>
      <section className="metrics"><Card><Statistic title="事件状态" value={state.incident.status} /></Card><Card><Statistic title="受影响车站" value={state.stations.filter((item) => item.status !== "正常").length} suffix="座" /></Card><Card><Statistic title="待执行计划" value={state.plans.filter((item) => item.status === "待确认" || item.status === "已确认").length} /></Card><Card><Statistic title="待同步操作" value={state.pendingActions.length} /></Card></section>
      {!state.online && <div className="degrade">当前处于弱网降级模式，显示最近缓存数据。确认等关键处置先进入本地队列，回网后按计划编号去重同步，失败留待重试。</div>}
      {panel === "总览" && <section className="overview">
        <Card title={t("stations")} className="wide"><Table rowKey="id" dataSource={state.online && cachedStations?.length ? cachedStations : state.stations} columns={stationColumns} pagination={false} size="small" scroll={{ x: 760 }} /></Card>
        <Card title="受影响区段" className="map-card"><MapPanel stations={state.stations} plans={state.plans.filter((plan) => plan.status !== "草稿" && plan.status !== "已失效")} /></Card>
      </section>}
      {panel === "事件时间线" && <Card title="处置时间线" extra={<Space><Select value="响应" options={[{value:"响应"},{value:"接驳"},{value:"恢复"}]} /><Button type="primary" onClick={() => state.addTimeline({ actor: state.role, action: "更新处置", detail: "现场处置信息已同步至协同工作台", phase: "响应" })}>添加处置记录</Button></Space>}><div className="timeline-grid"><Timeline items={state.timeline.map((item) => ({ color: item.phase === "恢复" ? "green" : item.phase === "接驳" ? "blue" : "red", children: <div><b>{item.action}</b><Tag>{item.actor}</Tag><p>{item.detail}</p><small>{format(new Date(item.time), "MM-DD HH:mm:ss")} · {item.phase}</small></div> }))} /><Card size="small" title="处置检查"><p>车站封闭与广播口径已确认。</p><p>接驳计划需调度员和公交接驳负责人双方会签，执行时回填实际到场车辆和间隔。</p><p>恢复行车前检查区间水位和站台安全。</p></Card></div></Card>}
      {panel === "接驳计划" && <Card title="公交接驳计划" extra={<Button type="primary" disabled={state.role !== "公交接驳负责人" && state.role !== "调度员"} onClick={() => setModalOpen(true)}>新建计划</Button>}><Table rowKey="id" pagination={false} dataSource={state.plans} columns={planColumns} scroll={{ x: 960 }} /></Card>}
      {panel === "确认中心" && <Card title="跨岗位确认中心" extra={<Button disabled={!state.online || !state.pendingActions.length} onClick={handleSync}>人工确认并同步本地队列</Button>}><Timeline items={state.plans.map((plan) => ({ children: <div className="approval"><b>{plan.stations.join(" → ")}</b><Tag color={planStatusColor[plan.status]}>{plan.status}</Tag><p>{plan.vehicles} 辆，间隔 {plan.interval} 分钟，{plan.note}</p><small>会签：{REQUIRED_APPROVERS.map((role) => `${role} ${plan.approvals.includes(role) ? "✓" : "✗"}`).join("，")}</small>{plan.actualVehicles != null && <p>实际到场 {plan.actualVehicles} 辆 / 间隔 {plan.actualInterval ?? "—"} 分钟（{plan.executedAt ? format(new Date(plan.executedAt), "MM-DD HH:mm") : "—"} 由{plan.executedBy}登记）{plan.status === "未达标" ? "，少于计划标准" : ""}</p>}{plan.invalidReason && <p>失效原因：{plan.invalidReason}</p>}</div> }))} />{state.pendingActions.length > 0 && <Table rowKey="id" size="small" pagination={false} style={{ marginTop: 16 }} title={() => "本地待同步队列"} dataSource={state.pendingActions} columns={queueColumns} />}</Card>}
    </main>
    <Modal title="新建接驳计划" open={modalOpen} onCancel={() => setModalOpen(false)} onOk={handleSubmit(submitPlan)} okText="保存草稿"><Form layout="vertical"><Form.Item label="接驳站" validateStatus={errors.stations ? "error" : ""} help={errors.stations?.message}><Controller name="stations" control={control} render={({ field }) => <Select mode="multiple" {...field} options={state.stations.map((item) => ({ value: item.name, label: item.name }))} />} /></Form.Item><Space><Form.Item label="车辆数"><Controller name="vehicles" control={control} render={({ field }) => <InputNumber {...field} min={1} />} /></Form.Item><Form.Item label="发车间隔"><Controller name="interval" control={control} render={({ field }) => <InputNumber {...field} min={2} addonAfter="分钟" />} /></Form.Item></Space><Form.Item label="运营方"><Controller name="operator" control={control} render={({ field }) => <Input {...field} />} /></Form.Item><Form.Item label="计划说明"><Controller name="note" control={control} render={({ field }) => <Input.TextArea {...field} />} /></Form.Item></Form></Modal>
    <Modal title="执行登记 · 实际到场对账" open={executeTarget != null} onCancel={() => setExecuteTarget(null)} onOk={confirmExecute} okText="登记并执行">{executeTarget && <Form layout="vertical"><p>计划：{executeTarget.stations.join(" → ")}，{executeTarget.vehicles} 辆 / 间隔 {executeTarget.interval} 分钟。实际到场少于计划将标记为未达标，登记后不可改写。</p><Form.Item label="实际到场车辆"><InputNumber min={0} value={actualVehicles} onChange={(value) => setActualVehicles(Number(value ?? 0))} addonAfter="辆" /></Form.Item><Form.Item label="实际发车间隔"><InputNumber min={0} value={actualInterval} onChange={(value) => setActualInterval(Number(value ?? 0))} addonAfter="分钟" /></Form.Item></Form>}</Modal>
  </div>;
}

export default function Page() { return <AntApp><Dashboard /></AntApp>; }
