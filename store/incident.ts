import { create } from "zustand";
import { persist } from "zustand/middleware";

export type Role = "调度员" | "车站值班员" | "公交接驳负责人" | "客服主管";
export type IncidentStatus = "处置中" | "控制中" | "已恢复";
export type StationStatus = "正常" | "限流" | "封闭" | "恢复中";
export type PlanStatus = "草稿" | "待确认" | "已确认" | "已执行" | "未达标" | "已失效";

/** 会签岗位：调度员和公交接驳负责人两边都确认，计划才算通过 */
export const REQUIRED_APPROVERS: Role[] = ["调度员", "公交接驳负责人"];

/** 计划状态由岗位会签推导；同一岗位重复确认只算一次（approvals 以岗位去重） */
export const derivePlanStatus = (approvals: Role[]): PlanStatus =>
  REQUIRED_APPROVERS.every((role) => approvals.includes(role)) ? "已确认" : "待确认";

export interface TimelineEntry {
  id: string;
  time: string;
  actor: Role;
  action: string;
  detail: string;
  phase: "发现" | "响应" | "接驳" | "恢复";
}

export interface Station {
  id: string;
  name: string;
  section: string;
  status: StationStatus;
  passengerRisk: "低" | "中" | "高";
  note: string;
  updatedAt: string;
}

export interface ShuttlePlan {
  id: string;
  stations: string[];
  vehicles: number;
  interval: number;
  operator: string;
  status: PlanStatus;
  approvals: Role[];
  note: string;
  actualVehicles?: number;
  actualInterval?: number;
  executedAt?: string;
  executedBy?: Role;
  invalidatedAt?: string;
  invalidReason?: string;
}

export interface PendingAction {
  id: string;
  kind: "confirmPlan" | "generic";
  action: string;
  detail: string;
  time: string;
  planId?: string;
  approvers?: Role[];
  attempts: number;
  lastError?: string;
}

export interface ActionResult {
  ok: boolean;
  queued?: boolean;
  duplicate?: boolean;
  reason?: string;
  status?: PlanStatus;
}

interface IncidentState {
  incident: { id: string; title: string; status: IncidentStatus; startedAt: string; section: string };
  stations: Station[];
  timeline: TimelineEntry[];
  plans: ShuttlePlan[];
  role: Role;
  online: boolean;
  pendingActions: PendingAction[];
  setRole: (role: Role) => void;
  setOnline: (online: boolean) => void;
  setStationStatus: (id: string, status: StationStatus, note?: string) => void;
  addTimeline: (entry: Omit<TimelineEntry, "id" | "time">) => void;
  addPlan: (plan: Omit<ShuttlePlan, "id" | "status" | "approvals">) => void;
  submitPlan: (id: string) => void;
  approvePlan: (id: string, approver: Role) => ActionResult;
  executePlan: (id: string, actual: { vehicles: number; interval: number }) => ActionResult;
  queueAction: (action: string, detail: string) => void;
  syncActions: () => { synced: number; remaining: number };
}

const now = () => new Date().toISOString();

const seedStations: Station[] = [
  { id: "s1", name: "滨江站", section: "中心-滨江", status: "封闭", passengerRisk: "高", note: "站台积水，已启动公交接驳", updatedAt: now() },
  { id: "s2", name: "会展中心站", section: "会展-滨江", status: "限流", passengerRisk: "中", note: "出入口单向组织", updatedAt: now() },
  { id: "s3", name: "东港站", section: "滨江-东港", status: "正常", passengerRisk: "低", note: "做好接班车准备", updatedAt: now() }
];

export const useIncidentStore = create<IncidentState>()(persist((set, get) => ({
  incident: { id: "INC-20260929-03", title: "滨江站区间积水停运", status: "处置中", startedAt: new Date(Date.now() - 35 * 60000).toISOString(), section: "中心站—东港站" },
  stations: seedStations,
  timeline: [
    { id: "e1", time: new Date(Date.now() - 35 * 60000).toISOString(), actor: "调度员", action: "启动事件", detail: "监测到滨江站区间水位超限，暂停双向行车", phase: "发现" },
    { id: "e2", time: new Date(Date.now() - 27 * 60000).toISOString(), actor: "车站值班员", action: "封闭车站", detail: "滨江站双向入口封闭并组织乘客出站", phase: "响应" }
  ],
  plans: [
    { id: "p1", stations: ["滨江站", "会展中心站"], vehicles: 8, interval: 6, operator: "东城公交", status: "待确认", approvals: ["调度员"], note: "优先疏运站外滞留乘客" }
  ],
  role: "调度员",
  online: true,
  pendingActions: [],
  setRole: (role) => set({ role }),
  setOnline: (online) => set({ online }),
  setStationStatus: (id, status, note) => set((state) => {
    const station = state.stations.find((item) => item.id === id);
    const time = now();
    // 车站状态更新后，待执行计划（待确认/已确认）立即失效，已执行记录不受影响
    const invalidated = state.plans.filter((plan) => plan.status === "待确认" || plan.status === "已确认");
    const entries: TimelineEntry[] = [{ id: crypto.randomUUID(), time, actor: state.role, action: "更新车站状态", detail: `${station?.name ?? id} → ${status}`, phase: status === "正常" || status === "恢复中" ? "恢复" : "响应" }];
    if (invalidated.length) entries.unshift({ id: crypto.randomUUID(), time, actor: state.role, action: "待执行计划失效", detail: `车站状态更新，${invalidated.length} 条待执行计划立即失效，需重新制定会签`, phase: "接驳" });
    return {
      stations: state.stations.map((item) => item.id === id ? { ...item, status, note: note ?? item.note, updatedAt: time } : item),
      plans: state.plans.map((plan) => plan.status === "待确认" || plan.status === "已确认" ? { ...plan, status: "已失效" as PlanStatus, invalidatedAt: time, invalidReason: `车站状态更新（${station?.name ?? id} → ${status}）` } : plan),
      timeline: [...entries, ...state.timeline],
      pendingActions: state.online ? state.pendingActions : [{ id: crypto.randomUUID(), kind: "generic" as const, action: "更新车站状态", detail: `${station?.name} → ${status}`, time, attempts: 0 }, ...state.pendingActions]
    };
  }),
  addTimeline: (entry) => set((state) => ({ timeline: [{ ...entry, id: crypto.randomUUID(), time: now() }, ...state.timeline], pendingActions: state.online ? state.pendingActions : [{ id: crypto.randomUUID(), kind: "generic" as const, action: entry.action, detail: entry.detail, time: now(), attempts: 0 }, ...state.pendingActions] })),
  addPlan: (plan) => set((state) => ({ plans: [{ ...plan, id: crypto.randomUUID(), status: "草稿", approvals: [] }, ...state.plans] })),
  submitPlan: (id) => {
    const plan = get().plans.find((item) => item.id === id);
    if (!plan || plan.status !== "草稿") return;
    set((state) => ({ plans: state.plans.map((item) => item.id === id ? { ...item, status: derivePlanStatus(item.approvals) } : item), timeline: [{ id: crypto.randomUUID(), time: now(), actor: state.role, action: "提交接驳计划", detail: `计划 ${id.slice(0, 6)} 等待调度员与公交接驳负责人会签`, phase: "接驳" }, ...state.timeline] }));
  },
  approvePlan: (id, approver) => {
    const plan = get().plans.find((item) => item.id === id);
    if (!plan) return { ok: false, reason: "计划不存在" };
    // 客服主管等非会签岗位代签，按越权拒绝并留痕
    if (!REQUIRED_APPROVERS.includes(approver)) {
      set((state) => ({ timeline: [{ id: crypto.randomUUID(), time: now(), actor: approver, action: "越权确认被拒", detail: `${approver} 不在会签岗位（${REQUIRED_APPROVERS.join("、")}）内，确认已按越权拒绝`, phase: "接驳" }, ...state.timeline] }));
      return { ok: false, reason: `${approver} 无会签权限，已按越权拒绝` };
    }
    // 已执行记录不能被后来的确认改写
    if (plan.status === "已执行" || plan.status === "未达标") return { ok: false, reason: "计划已执行，执行记录不可被确认改写" };
    if (plan.status === "已失效") return { ok: false, reason: "计划已失效，请重新制定并会签" };
    if (plan.status === "草稿") return { ok: false, reason: "草稿需先提交确认" };
    // 弱网：确认先攒本地队列，按计划编号去重合并，回网后统一同步
    if (!get().online) {
      set((state) => {
        const existing = state.pendingActions.find((item) => item.kind === "confirmPlan" && item.planId === id);
        if (existing) {
          const approvers = Array.from(new Set([...(existing.approvers ?? []), approver]));
          return { pendingActions: state.pendingActions.map((item) => item.id === existing.id ? { ...item, approvers, detail: `计划 ${id.slice(0, 6)} 会签：${approvers.join("、")}` } : item) };
        }
        return { pendingActions: [{ id: crypto.randomUUID(), kind: "confirmPlan" as const, planId: id, approvers: [approver], action: "确认接驳计划", detail: `计划 ${id.slice(0, 6)} 会签：${approver}`, time: now(), attempts: 0 }, ...state.pendingActions] };
      });
      return { ok: true, queued: true, reason: "弱网环境，确认已存入本地队列，回网后按计划编号同步" };
    }
    const duplicate = plan.approvals.includes(approver);
    const approvals = Array.from(new Set([...plan.approvals, approver]));
    const status = derivePlanStatus(approvals);
    set((state) => ({
      plans: state.plans.map((item) => item.id === id ? { ...item, approvals, status } : item),
      timeline: [{ id: crypto.randomUUID(), time: now(), actor: approver, action: duplicate ? "重复确认忽略" : "确认接驳计划", detail: duplicate ? `${approver} 已确认过，同一岗位重复确认只计一次` : `${approver} 已会签（${approvals.length}/${REQUIRED_APPROVERS.length}）${status === "已确认" ? "，双岗位会签通过" : "，等待另一岗位确认"}`, phase: "接驳" }, ...state.timeline]
    }));
    return { ok: true, duplicate, status };
  },
  executePlan: (id, actual) => {
    const state = get();
    const plan = state.plans.find((item) => item.id === id);
    if (!plan) return { ok: false, reason: "计划不存在" };
    if (plan.status === "已执行" || plan.status === "未达标") return { ok: false, reason: "计划已执行，记录不可改写" };
    if (plan.status !== "已确认") return { ok: false, reason: "计划未完成双岗位会签，不能执行" };
    // 登记实际到场车辆和间隔并与计划对账：车辆少于计划或间隔大于计划记为未达标
    const met = actual.vehicles >= plan.vehicles && actual.interval <= plan.interval;
    const status: PlanStatus = met ? "已执行" : "未达标";
    const time = now();
    set((current) => ({
      plans: current.plans.map((item) => item.id === id ? { ...item, status, actualVehicles: actual.vehicles, actualInterval: actual.interval, executedAt: time, executedBy: current.role } : item),
      timeline: [{ id: crypto.randomUUID(), time, actor: current.role, action: met ? "执行接驳计划" : "执行未达标", detail: `实际到场 ${actual.vehicles} 辆 / 间隔 ${actual.interval} 分钟（计划 ${plan.vehicles} 辆 / ${plan.interval} 分钟）${met ? "，对账达标" : "，少于计划标准，标记未达标"}`, phase: "接驳" }, ...current.timeline]
    }));
    return { ok: true, status };
  },
  queueAction: (action, detail) => set((state) => ({ pendingActions: [{ id: crypto.randomUUID(), kind: "generic" as const, action, detail, time: now(), attempts: 0 }, ...state.pendingActions] })),
  syncActions: () => {
    const state = get();
    if (!state.online) return { synced: 0, remaining: state.pendingActions.length };
    // 回网同步：确认类动作按计划编号去重后逐条应用，失败的留在队列里重试
    const confirmsByPlan = new Map<string, PendingAction>();
    let synced = 0;
    for (const action of state.pendingActions) {
      if (action.kind === "confirmPlan" && action.planId) {
        const existing = confirmsByPlan.get(action.planId);
        confirmsByPlan.set(action.planId, existing ? { ...existing, approvers: Array.from(new Set([...(existing.approvers ?? []), ...(action.approvers ?? [])])) } : { ...action });
      } else {
        synced += 1; // 通用动作离线时已落本地，回网即视为同步完成
      }
    }
    const remaining: PendingAction[] = [];
    for (const action of confirmsByPlan.values()) {
      let error: string | undefined;
      for (const approver of action.approvers ?? []) {
        const result = get().approvePlan(action.planId as string, approver);
        if (!result.ok) error = result.reason;
      }
      if (error) remaining.push({ ...action, attempts: action.attempts + 1, lastError: error });
      else synced += 1;
    }
    set({ pendingActions: remaining });
    return { synced, remaining: remaining.length };
  }
}), {
  name: "pair-wise-yf-47/incident",
  version: 2,
  migrate: (persisted, version) => {
    const state = persisted as IncidentState;
    if (version < 2) {
      // 老数据迁移：待确认/已确认状态按会签记录重新推导，本地队列动作补齐字段
      state.plans = (state.plans ?? []).map((plan) => plan.status === "待确认" || plan.status === "已确认" ? { ...plan, status: derivePlanStatus(plan.approvals ?? []) } : plan);
      state.pendingActions = (state.pendingActions ?? []).map((action) => ({ ...action, kind: action.kind ?? "generic", attempts: action.attempts ?? 0 }));
    }
    return state;
  }
}));
