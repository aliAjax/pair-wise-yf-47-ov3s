"use client";

import { useEffect, useState } from "react";
import { App as AntApp, Badge, Button, Card, Descriptions, Form, Input, InputNumber, Modal, Select, Segmented, Space, Statistic, Table, Tag, Timeline, Tooltip, message } from "antd";
import { format } from "date-fns";
import { useForm, Controller } from "react-hook-form";
import { z } from "zod";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import type { ColumnsType } from "antd/es/table";
import { fetchStations } from "../lib/query";
import { MapPanel } from "../components/MapPanel";
import { useIncidentStore, type Role, type ShuttlePlan, type Station, type StationStatus, type PlanStatus, type QueuedConfirmation } from "../store/incident";

const planSchema = z.object({ stations: z.array(z.string()).min(1, "至少选择两个接驳站"), vehicles: z.number().min(1).max(80), interval: z.number().min(2).max(30), operator: z.string().min(2), note: z.string().min(2) });
type PlanForm = z.infer<typeof planSchema>;

const execSchema = z.object({ actualVehicles: z.number().min(1, "实际车辆数至少 1"), actualInterval: z.number().min(1, "实际间隔至少 1") });
type ExecForm = z.infer<typeof execSchema>;

const PLAN_STATUS_COLOR: Record<PlanStatus, string> = { "草稿": "default", "待确认": "orange", "已确认": "green", "已执行": "blue", "已失效": "red" };

function Dashboard() {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const [messageApi, contextHolder] = message.useMessage();
  const state = useIncidentStore();
  const { data: cachedStations } = useQuery({ queryKey: ["stations"], queryFn: fetchStations, enabled: state.online });
  const [modalOpen, setModalOpen] = useState(false);
  const [execModalOpen, setExecModalOpen] = useState(false);
  const [execPlan, setExecPlan] = useState<ShuttlePlan | null>(null);
  const [panel, setPanel] = useState<string>("总览");
  const { control, handleSubmit, reset, formState: { errors } } = useForm<PlanForm>({ defaultValues: { stations: ["滨江站", "会展中心站"], vehicles: 8, interval: 6, operator: "东城公交", note: "优先疏运站外滞留乘客" } });
  const { control: execControl, handleSubmit: execHandleSubmit, reset: execReset, formState: { errors: execErrors } } = useForm<ExecForm>({ defaultValues: { actualVehicles: 8, actualInterval: 6 } });

  useEffect(() => { if (!state.online) queryClient.cancelQueries({ queryKey: ["stations"] }); }, [state.online, queryClient]);

  const pendingConfirmations = state.confirmationQueue.filter((q) => q.status === "pending").length;
  const failedConfirmations = state.confirmationQueue.filter((q) => q.status === "failed").length;

  const stationColumns: ColumnsType<Station> = [
    { title: "车站", dataIndex: "name" },
    { title: "区段", dataIndex: "section" },
    { title: "状态", dataIndex: "status", render: (value: StationStatus) => <Tag color={value === "封闭" ? "red" : value === "限流" ? "orange" : value === "恢复中" ? "blue" : "green"}>{value}</Tag> },
    { title: "滞留风险", dataIndex: "passengerRisk", render: (value) => <Badge status={value === "高" ? "error" : value === "中" ? "warning" : "success"} text={value} /> },
    { title: "现场说明", dataIndex: "note" },
    { title: "更新时间", dataIndex: "updatedAt", render: (value: string) => format(new Date(value), "HH:mm:ss") },
    { title: "处置", render: (_, record) => <Space><Button size="small" disabled={state.role === "客服主管"} onClick={() => state.setStationStatus(record.id, "限流")}>限流</Button><Button size="small" disabled={state.role === "客服主管"} danger={record.status !== "封闭"} onClick={() => state.setStationStatus(record.id, record.status === "封闭" ? "恢复中" : "封闭")}>{record.status === "封闭" ? "恢复中" : "封闭"}</Button></Space> }
  ];

  const submitPlan = (values: PlanForm) => { const parsed = planSchema.safeParse(values); if (!parsed.success) return; state.addPlan(parsed.data); setModalOpen(false); reset(); };

  const handleApprove = (plan: ShuttlePlan) => {
    const result = state.approvePlan(plan.id, state.role, state.role);
    if (result.ok) messageApi.success(result.reason ?? "已确认");
    else messageApi.error(result.reason ?? "确认失败");
  };

  const openExecModal = (plan: ShuttlePlan) => {
    setExecPlan(plan);
    execReset({ actualVehicles: plan.vehicles, actualInterval: plan.interval });
    setExecModalOpen(true);
  };

  const submitExecution = (values: ExecForm) => {
    if (!execPlan) return;
    const result = state.executePlan(execPlan.id, values.actualVehicles, values.actualInterval);
    if (result.ok) {
      messageApi.success(`计划已执行：实际 ${values.actualVehicles} 辆 / 间隔 ${values.actualInterval} 分钟，${values.actualVehicles >= execPlan.vehicles && values.actualInterval <= execPlan.interval ? "达标" : "未达标"}`);
      setExecModalOpen(false);
      setExecPlan(null);
    } else {
      messageApi.error(result.reason ?? "执行失败");
    }
  };

  const handleSync = async () => {
    const result = await state.syncConfirmations();
    if (result.failed > 0) messageApi.warning(`同步完成：成功 ${result.synced} 条，失败 ${result.failed} 条（可重试）`);
    else messageApi.success(`同步完成：成功 ${result.synced} 条`);
  };

  const handleRetry = async () => {
    await state.retryFailedConfirmations();
    messageApi.info("已重试失败项");
  };

  const planColumns: ColumnsType<ShuttlePlan> = [
    { title: "接驳站", dataIndex: "stations", render: (v: string[]) => v.join(" → ") },
    { title: "车辆", dataIndex: "vehicles" },
    { title: "间隔", dataIndex: "interval", render: (v: number) => `${v} 分钟` },
    { title: "运营方", dataIndex: "operator" },
    { title: "会签", dataIndex: "approvals", render: (v: ShuttlePlan["approvals"]) => v.length ? <Space size={4} wrap>{v.map((a) => <Tooltip key={a.role} title={`${a.by} · ${format(new Date(a.at), "MM-DD HH:mm")}`}><Tag color="green">{a.role}</Tag></Tooltip>)}</Space> : <Tag>未确认</Tag> },
    { title: "状态", dataIndex: "status", render: (v: PlanStatus) => <Tag color={PLAN_STATUS_COLOR[v]}>{v}</Tag> },
    { title: "实际/对账", render: (_, record) => record.status === "已执行" ? <Space size={4}><Tag color="blue">{record.actualVehicles} 辆</Tag><Tag color="blue">{record.actualInterval} 分钟</Tag>{record.qualified ? <Tag color="green">达标</Tag> : <Tag color="red">未达标</Tag>}</Space> : <Tag>—</Tag> },
    { title: "操作", render: (_, record: ShuttlePlan) => <Space><Button size="small" disabled={record.status !== "草稿"} onClick={() => state.submitPlan(record.id)}>提交确认</Button><Button size="small" disabled={record.status !== "待确认"} onClick={() => handleApprove(record)}>确认</Button><Button size="small" type="primary" disabled={record.status !== "已确认"} onClick={() => openExecModal(record)}>执行</Button></Space> }
  ];

  return <div className="shell">
    {contextHolder}
    <aside className="side">
      <div className="brand"><b>RAIL OPS</b><span>应急协同</span></div>
      <nav>{["总览", "事件时间线", "接驳计划", "确认中心"].map((item) => <button className={panel === item ? "active" : ""} key={item} onClick={() => setPanel(item)}>{item}</button>)}</nav>
      <div className="side-status"><small>系统连接</small><b className={state.online ? "ok" : "warn"}>{state.online ? "在线" : "弱网降级"}</b><span>最近缓存 32 秒前</span></div>
    </aside>
    <main>
      <header><div><small>{state.incident.id} · 启动于 {format(new Date(state.incident.startedAt), "HH:mm")}</small><h1>{t("title")}</h1><p>{t("subtitle")}</p></div><Space><Segmented value={state.online} onChange={(value) => state.setOnline(Boolean(value))} options={[{ label: "在线", value: true }, { label: "弱网", value: false }]} /><Select<Role> value={state.role} onChange={state.setRole} options={["调度员", "车站值班员", "公交接驳负责人", "客服主管"].map((value) => ({ value: value as Role, label: `角色：${value}` }))} /></Space></header>
      <section className="metrics"><Card><Statistic title="事件状态" value={state.incident.status} /></Card><Card><Statistic title="受影响车站" value={state.stations.filter((item) => item.status !== "正常").length} suffix="座" /></Card><Card><Statistic title="待确认计划" value={state.plans.filter((item) => item.status === "待确认").length} /></Card><Card><Statistic title="待同步确认" value={state.confirmationQueue.length} /></Card></section>
      {!state.online && <div className="degrade">当前处于弱网降级模式，显示最近缓存数据。关键处置会进入本地队列，恢复连接后需人工确认提交。</div>}
      {panel === "总览" && <section className="overview">
        <Card title={t("stations")} className="wide"><Table rowKey="id" dataSource={state.online && cachedStations?.length ? cachedStations : state.stations} columns={stationColumns} pagination={false} size="small" scroll={{ x: 760 }} /></Card>
        <Card title="受影响区段" className="map-card"><MapPanel stations={state.stations} plans={state.plans.filter((plan) => plan.status !== "草稿")} /></Card>
      </section>}
      {panel === "事件时间线" && <Card title="处置时间线" extra={<Space><Select value="响应" options={[{value:"响应"},{value:"接驳"},{value:"恢复"}]} /><Button type="primary" onClick={() => state.addTimeline({ actor: state.role, action: "更新处置", detail: "现场处置信息已同步至协同工作台", phase: "响应" })}>添加处置记录</Button></Space>}><div className="timeline-grid"><Timeline items={state.timeline.map((item) => ({ color: item.phase === "恢复" ? "green" : item.phase === "接驳" ? "blue" : "red", children: <div><b>{item.action}</b><Tag>{item.actor}</Tag><p>{item.detail}</p><small>{format(new Date(item.time), "MM-DD HH:mm:ss")} · {item.phase}</small></div> }))} /><Card size="small" title="处置检查"><p>车站封闭与广播口径已确认。</p><p>接驳车辆到场后需调度员和公交负责人双方会签。</p><p>恢复行车前检查区间水位和站台安全。</p></Card></div></Card>}
      {panel === "接驳计划" && <Card title="公交接驳计划" extra={<Button type="primary" disabled={state.role !== "公交接驳负责人" && state.role !== "调度员"} onClick={() => setModalOpen(true)}>新建计划</Button>}><Table rowKey="id" pagination={false} dataSource={state.plans} columns={planColumns} /></Card>}
      {panel === "确认中心" && <Card title="跨岗位会签中心" extra={<Space>{pendingConfirmations > 0 && <Tag color="orange">待同步 {pendingConfirmations}</Tag>}{failedConfirmations > 0 && <Tag color="red">失败 {failedConfirmations}</Tag>}<Button disabled={!state.online || !state.confirmationQueue.length} onClick={handleSync}>同步本地队列</Button><Button disabled={!failedConfirmations} onClick={handleRetry}>重试失败项</Button></Space>}>
        <Timeline items={state.plans.map((plan) => ({ children: <div className="approval"><b>{plan.stations.join(" → ")}</b><Tag color={PLAN_STATUS_COLOR[plan.status]}>{plan.status}</Tag><p>{plan.vehicles} 辆，间隔 {plan.interval} 分钟，{plan.note}</p><small>已会签：{plan.approvals.length ? plan.approvals.map((a) => a.role).join("、") : "暂无"}</small>{plan.status === "已执行" && <small> · 实际 {plan.actualVehicles} 辆 / {plan.actualInterval} 分钟 · {plan.qualified ? "达标" : "未达标"}</small>}</div> }))} />
        {state.confirmationQueue.length > 0 && <Card size="small" title="本地确认队列" style={{ marginTop: 16 }}><Table rowKey="id" size="small" pagination={false} dataSource={state.confirmationQueue} columns={[{ title: "计划编号", dataIndex: "planId", render: (v: string) => v.slice(0, 8) }, { title: "岗位", dataIndex: "role", render: (v: Role) => <Tag>{v}</Tag> }, { title: "确认人", dataIndex: "by" }, { title: "时间", dataIndex: "time", render: (v: string) => format(new Date(v), "MM-DD HH:mm:ss") }, { title: "状态", dataIndex: "status", render: (v: QueuedConfirmation["status"], record) => <Space><Tag color={v === "failed" ? "red" : "orange"}>{v === "failed" ? "失败" : "待同步"}</Tag>{record.retries > 0 && <small>重试 {record.retries} 次</small>}</Space> }, { title: "原因", dataIndex: "error", render: (v?: string) => v ?? "—" }]} /></Card>}
        <Card size="small" title="会签规则" style={{ marginTop: 16 }}><p>· 计划须经调度员与公交接驳负责人双方会签后方可执行。</p><p>· 同一岗位重复确认只算一次；客服主管代签按越权拒绝。</p><p>· 已执行记录不可改写；车站状态更新后待执行计划立即失效。</p><p>· 弱网下确认先攒本地，回网后按计划编号同步去重，失败留下重试。</p></Card>
      </Card>}
    </main>
    <Modal title="新建接驳计划" open={modalOpen} onCancel={() => setModalOpen(false)} onOk={handleSubmit(submitPlan)} okText="保存草稿"><Form layout="vertical"><Form.Item label="接驳站" validateStatus={errors.stations ? "error" : ""} help={errors.stations?.message}><Controller name="stations" control={control} render={({ field }) => <Select mode="multiple" {...field} options={state.stations.map((item) => ({ value: item.name, label: item.name }))} />} /></Form.Item><Space><Form.Item label="车辆数"><Controller name="vehicles" control={control} render={({ field }) => <InputNumber {...field} min={1} />} /></Form.Item><Form.Item label="发车间隔"><Controller name="interval" control={control} render={({ field }) => <InputNumber {...field} min={2} addonAfter="分钟" />} /></Form.Item></Space><Form.Item label="运营方"><Controller name="operator" control={control} render={({ field }) => <Input {...field} />} /></Form.Item><Form.Item label="计划说明"><Controller name="note" control={control} render={({ field }) => <Input.TextArea {...field} />} /></Form.Item></Form></Modal>
    <Modal title="执行接驳计划" open={execModalOpen} onCancel={() => { setExecModalOpen(false); setExecPlan(null); }} onOk={execHandleSubmit(submitExecution)} okText="确认执行"><p>{execPlan?.stations.join(" → ")}：计划 {execPlan?.vehicles} 辆 / 间隔 {execPlan?.interval} 分钟</p><Form layout="vertical"><Space><Form.Item label="实际到场车辆数" validateStatus={execErrors.actualVehicles ? "error" : ""} help={execErrors.actualVehicles?.message}><Controller name="actualVehicles" control={execControl} render={({ field }) => <InputNumber {...field} min={1} addonAfter="辆" />} /></Form.Item><Form.Item label="实际发车间隔" validateStatus={execErrors.actualInterval ? "error" : ""} help={execErrors.actualInterval?.message}><Controller name="actualInterval" control={execControl} render={({ field }) => <InputNumber {...field} min={1} addonAfter="分钟" />} /></Form.Item></Space></Form></Modal>
  </div>
}

export default function Page() { return <AntApp><Dashboard /></AntApp>; }
