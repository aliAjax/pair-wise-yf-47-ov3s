import { create } from "zustand";
import { persist } from "zustand/middleware";

export type Role = "调度员" | "车站值班员" | "公交接驳负责人" | "客服主管";
export type IncidentStatus = "处置中" | "控制中" | "已恢复";
export type StationStatus = "正常" | "限流" | "封闭" | "恢复中";
export type PlanStatus = "草稿" | "待确认" | "已确认" | "已执行" | "已失效";

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

export interface Approval {
  role: Role;
  by: string;
  at: string;
}

export interface ShuttlePlan {
  id: string;
  stations: string[];
  vehicles: number;
  interval: number;
  operator: string;
  status: PlanStatus;
  approvals: Approval[];
  note: string;
  actualVehicles?: number;
  actualInterval?: number;
  qualified?: boolean;
}

export interface PendingAction {
  id: string;
  action: string;
  detail: string;
  time: string;
}

export interface QueuedConfirmation {
  id: string;
  planId: string;
  role: Role;
  by: string;
  time: string;
  status: "pending" | "failed";
  retries: number;
  error?: string;
}

interface IncidentState {
  incident: { id: string; title: string; status: IncidentStatus; startedAt: string; section: string };
  stations: Station[];
  timeline: TimelineEntry[];
  plans: ShuttlePlan[];
  role: Role;
  online: boolean;
  pendingActions: PendingAction[];
  confirmationQueue: QueuedConfirmation[];
  setRole: (role: Role) => void;
  setOnline: (online: boolean) => void;
  setStationStatus: (id: string, status: StationStatus, note?: string) => void;
  addTimeline: (entry: Omit<TimelineEntry, "id" | "time">) => void;
  addPlan: (plan: Omit<ShuttlePlan, "id" | "status" | "approvals">) => void;
  submitPlan: (id: string) => void;
  approvePlan: (id: string, role: Role, by: string) => { ok: boolean; reason?: string };
  executePlan: (id: string, actualVehicles: number, actualInterval: number) => { ok: boolean; reason?: string };
  queueAction: (action: string, detail: string) => void;
  syncActions: () => void;
  syncConfirmations: () => Promise<{ synced: number; failed: number }>;
  retryFailedConfirmations: () => Promise<void>;
}

const now = () => new Date().toISOString();

const REQUIRED_APPROVAL_ROLES: Role[] = ["调度员", "公交接驳负责人"];

function applyApproval(plan: ShuttlePlan, role: Role, by: string): { plan: ShuttlePlan; ok: boolean; reason?: string } {
  if (role === "客服主管") return { plan, ok: false, reason: "越权：客服主管不得代签接驳计划" };
  if (role !== "调度员" && role !== "公交接驳负责人") return { plan, ok: false, reason: "该岗位不参与接驳计划会签" };
  if (plan.status === "已执行") return { plan, ok: false, reason: "计划已执行，确认不可改写" };
  if (plan.status === "已失效") return { plan, ok: false, reason: "计划已失效" };
  if (plan.status !== "待确认") return { plan, ok: false, reason: "仅待确认计划可会签" };
  if (plan.approvals.some((a) => a.role === role)) return { plan, ok: true, reason: "该岗位已确认，无需重复" };
  const approvals = [...plan.approvals, { role, by, at: now() }];
  const status = REQUIRED_APPROVAL_ROLES.every((r) => approvals.some((a) => a.role === r)) ? "已确认" : plan.status;
  return { plan: { ...plan, approvals, status }, ok: true };
}

const seedStations: Station[] = [
  { id: "s1", name: "滨江站", section: "中心-滨江", status: "封闭", passengerRisk: "高", note: "站台积水，已启动公交接驳", updatedAt: now() },
  { id: "s2", name: "会展中心站", section: "会展-滨江", status: "限流", passengerRisk: "中", note: "出入口单向组织", updatedAt: now() },
  { id: "s3", name: "东港站", section: "滨江-东港", status: "正常", passengerRisk: "低", note: "做好接班车准备", updatedAt: now() }
];

export const useIncidentStore = create<IncidentState>()(
  persist(
    (set, get) => ({
      incident: { id: "INC-20260929-03", title: "滨江站区间积水停运", status: "处置中", startedAt: new Date(Date.now() - 35 * 60000).toISOString(), section: "中心站—东港站" },
      stations: seedStations,
      timeline: [
        { id: "e1", time: new Date(Date.now() - 35 * 60000).toISOString(), actor: "调度员", action: "启动事件", detail: "监测到滨江站区间水位超限，暂停双向行车", phase: "发现" },
        { id: "e2", time: new Date(Date.now() - 27 * 60000).toISOString(), actor: "车站值班员", action: "封闭车站", detail: "滨江站双向入口封闭并组织乘客出站", phase: "响应" }
      ],
      plans: [
        { id: "p1", stations: ["滨江站", "会展中心站"], vehicles: 8, interval: 6, operator: "东城公交", status: "待确认", approvals: [{ role: "调度员", by: "值班调度", at: now() }], note: "优先疏运站外滞留乘客" }
      ],
      role: "调度员",
      online: true,
      pendingActions: [],
      confirmationQueue: [],
      setRole: (role) => set({ role }),
      setOnline: (online) => set({ online }),
      setStationStatus: (id, status, note) => set((state) => {
        const station = state.stations.find((item) => item.id === id);
        const name = station?.name ?? id;
        const invalidated = state.plans.filter((plan) => plan.status === "待确认" || plan.status === "已确认");
        const entries: TimelineEntry[] = [
          { id: crypto.randomUUID(), time: now(), actor: state.role, action: "更新车站状态", detail: `${name} → ${status}`, phase: status === "正常" || status === "恢复中" ? "恢复" : "响应" }
        ];
        if (invalidated.length > 0) {
          entries.push({ id: crypto.randomUUID(), time: now(), actor: state.role, action: "接驳计划失效", detail: `${invalidated.length} 个待执行计划因车站状态更新立即失效`, phase: "接驳" });
        }
        return {
          stations: state.stations.map((item) => item.id === id ? { ...item, status, note: note ?? item.note, updatedAt: now() } : item),
          plans: state.plans.map((plan) => (plan.status === "待确认" || plan.status === "已确认") ? { ...plan, status: "已失效" } : plan),
          timeline: [...entries, ...state.timeline],
          pendingActions: state.online ? state.pendingActions : [{ id: crypto.randomUUID(), action: "更新车站状态", detail: `${name} → ${status}`, time: now() }, ...state.pendingActions]
        };
      }),
      addTimeline: (entry) => set((state) => ({ timeline: [{ ...entry, id: crypto.randomUUID(), time: now() }, ...state.timeline], pendingActions: state.online ? state.pendingActions : [{ id: crypto.randomUUID(), action: entry.action, detail: entry.detail, time: now() }, ...state.pendingActions] })),
      addPlan: (plan) => set((state) => ({ plans: [{ ...plan, id: crypto.randomUUID(), status: "草稿", approvals: [] }, ...state.plans] })),
      submitPlan: (id) => set((state) => ({ plans: state.plans.map((plan) => plan.id === id ? { ...plan, status: "待确认" } : plan), timeline: [{ id: crypto.randomUUID(), time: now(), actor: state.role, action: "提交接驳计划", detail: `计划 ${id.slice(0, 6)} 等待跨岗位会签`, phase: "接驳" }, ...state.timeline] })),
      approvePlan: (id, role, by) => {
        const state = get();
        if (!state.online) {
          set((s) => {
            const existing = s.confirmationQueue.find((q) => q.planId === id && q.role === role);
            const confirmation: QueuedConfirmation = { id: crypto.randomUUID(), planId: id, role, by, time: now(), status: "pending", retries: 0 };
            const confirmationQueue = existing
              ? s.confirmationQueue.map((q) => q.id === existing.id ? { ...confirmation, id: q.id } : q)
              : [confirmation, ...s.confirmationQueue];
            return { confirmationQueue };
          });
          return { ok: true, reason: "弱网：确认已攒入本地队列，回网后按计划编号同步" };
        }
        const plan = state.plans.find((item) => item.id === id);
        if (!plan) return { ok: false, reason: "计划不存在" };
        const result = applyApproval(plan, role, by);
        if (!result.ok) return { ok: false, reason: result.reason };
        set((s) => ({
          plans: s.plans.map((item) => item.id === id ? result.plan : item),
          timeline: [{ id: crypto.randomUUID(), time: now(), actor: role, action: "会签接驳计划", detail: `${plan.stations.join(" → ")}：${role} ${by} 已确认${result.plan.status === "已确认" ? "，调度员与公交接驳负责人双方会签通过" : ""}`, phase: "接驳" }, ...s.timeline]
        }));
        return { ok: true };
      },
      executePlan: (id, actualVehicles, actualInterval) => {
        const state = get();
        const plan = state.plans.find((item) => item.id === id);
        if (!plan) return { ok: false, reason: "计划不存在" };
        if (plan.status === "已执行") return { ok: false, reason: "计划已执行，记录不可改写" };
        if (plan.status !== "已确认") return { ok: false, reason: "仅已确认计划可执行" };
        if (actualVehicles < 1 || actualInterval < 1) return { ok: false, reason: "实际车辆/间隔无效" };
        const qualified = actualVehicles >= plan.vehicles && actualInterval <= plan.interval;
        set((s) => ({
          plans: s.plans.map((item) => item.id === id ? { ...item, status: "已执行", actualVehicles, actualInterval, qualified } : item),
          timeline: [{ id: crypto.randomUUID(), time: now(), actor: s.role, action: "执行接驳计划", detail: `${plan.stations.join(" → ")}：到场 ${actualVehicles} 辆 / 间隔 ${actualInterval} 分钟（计划 ${plan.vehicles} 辆 / ${plan.interval} 分钟），${qualified ? "达标" : "未达标"}`, phase: "接驳" }, ...s.timeline]
        }));
        return { ok: true };
      },
      queueAction: (action, detail) => set((state) => ({ pendingActions: [{ id: crypto.randomUUID(), action, detail, time: now() }, ...state.pendingActions] })),
      syncActions: () => set({ pendingActions: [] }),
      syncConfirmations: async () => {
        const items = get().confirmationQueue.filter((q) => q.status === "pending" || q.status === "failed");
        let synced = 0;
        let failed = 0;
        for (const item of items) {
          await new Promise((resolve) => setTimeout(resolve, 180));
          const networkOk = Math.random() > 0.3;
          if (!networkOk) {
            set((s) => ({ confirmationQueue: s.confirmationQueue.map((q) => q.id === item.id ? { ...q, status: "failed", retries: q.retries + 1, error: "网络错误，同步失败" } : q) }));
            failed += 1;
            continue;
          }
          const plan = get().plans.find((p) => p.id === item.planId);
          if (!plan) {
            set((s) => ({ confirmationQueue: s.confirmationQueue.map((q) => q.id === item.id ? { ...q, status: "failed", retries: q.retries + 1, error: "计划不存在" } : q) }));
            failed += 1;
            continue;
          }
          const result = applyApproval(plan, item.role, item.by);
          if (!result.ok) {
            set((s) => ({ confirmationQueue: s.confirmationQueue.map((q) => q.id === item.id ? { ...q, status: "failed", retries: q.retries + 1, error: result.reason } : q) }));
            failed += 1;
            continue;
          }
          set((s) => ({
            confirmationQueue: s.confirmationQueue.filter((q) => q.id !== item.id),
            plans: s.plans.map((p) => p.id === item.planId ? result.plan : p),
            timeline: [{ id: crypto.randomUUID(), time: now(), actor: item.role, action: "同步会签", detail: `${plan.stations.join(" → ")}：${item.role} ${item.by} 离线确认已同步${result.plan.status === "已确认" ? "，双方会签通过" : ""}`, phase: "接驳" }, ...s.timeline]
          }));
          synced += 1;
        }
        return { synced, failed };
      },
      retryFailedConfirmations: async () => {
        set((s) => ({ confirmationQueue: s.confirmationQueue.map((q) => q.status === "failed" ? { ...q, status: "pending", error: undefined } : q) }));
        await get().syncConfirmations();
      }
    }),
    {
      name: "pair-wise-yf-47/incident",
      version: 2,
      migrate: (persistedState, version) => {
        if (version < 2) {
          const s = persistedState as Partial<IncidentState>;
          return {
            ...s,
            plans: (s.plans ?? []).map((p) => ({
              ...p,
              approvals: Array.isArray(p.approvals)
                ? (p.approvals as unknown as Array<Approval | string>).map((a) => typeof a === "string" ? { role: a as Role, by: a, at: now() } : a)
                : []
            })),
            confirmationQueue: s.confirmationQueue ?? []
          } as IncidentState;
        }
        return persistedState as IncidentState;
      }
    }
  )
);
