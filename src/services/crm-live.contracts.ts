import { z } from "zod";
import type {
  CompanyRow,
  ContactRow,
  PipelineRow,
  PipelineStageRow,
  OpportunityRow,
} from "@/types/database";
import type { AuthContext } from "@/types/domain";

export const entitySchema = z.enum([
  "contacts",
  "companies",
  "opportunities",
  "pipelines",
  "pipeline_stages",
]);
export type LiveEntity = z.infer<typeof entitySchema>;
export type LiveRow = Partial<
  Omit<ContactRow & CompanyRow & OpportunityRow & PipelineRow & PipelineStageRow, "amount">
> & { id: string; workspace_id: string; amount?: number | null };
export const uuid = z.string().uuid();
const nullableId = uuid.nullable().optional();
const text = (max: number) => z.string().trim().max(max).nullable().optional();
const name = (max: number) => z.string().trim().min(1).max(max);
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v);
const company = z
  .object({
    name: name(200),
    domain: text(253),
    industry: text(80),
    phone: text(40),
    owner_id: nullableId,
  })
  .strict();
const contact = z
  .object({
    full_name: name(200),
    email: z.string().email().max(320).nullable().optional(),
    phone: text(40),
    title: text(120),
    company_id: nullableId,
    owner_id: nullableId,
  })
  .strict();
const opportunity = z
  .object({
    name: name(200),
    pipeline_id: uuid,
    stage_id: uuid,
    contact_id: nullableId,
    company_id: nullableId,
    owner_id: nullableId,
    amount: z.number().finite().min(0).max(999999999999.99).optional(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    expected_close_date: date.nullable().optional(),
    status: z.enum(["open", "won", "lost"]).optional(),
  })
  .strict();
const pipeline = z.object({ name: name(120), is_default: z.boolean().optional() }).strict();
const stage = z
  .object({
    name: name(80),
    pipeline_id: uuid,
    position: z.number().int().min(0),
    stage_type: z.enum(["open", "won", "lost"]).optional(),
    probability: z.number().int().min(0).max(100).nullable().optional(),
  })
  .strict();
export function parseCrmValues(
  entity: LiveEntity,
  value: unknown,
  update: boolean,
): Record<string, unknown> {
  const schema = {
    contacts: contact,
    companies: company,
    opportunities: opportunity,
    pipelines: pipeline,
    pipeline_stages: stage,
  }[entity];
  return (update ? schema.partial() : schema).parse(value);
}
export function assertCrmIdentity(auth: AuthContext, expectedWorkspace?: string) {
  if (!auth.configured || !auth.enforced || !auth.user || !auth.activeWorkspace || auth.error)
    throw new Error("Sign in and select a verified workspace to use CRM.");
  if (!auth.memberships.some((m) => m.workspaceId === auth.activeWorkspace!.workspaceId))
    throw new Error("Workspace membership required.");
  if (expectedWorkspace && expectedWorkspace !== auth.activeWorkspace.workspaceId)
    throw new Error("Workspace changed. Refresh and try again.");
  return { workspaceId: auth.activeWorkspace.workspaceId, userId: auth.user.id };
}
// No monetary permission exists in the approved catalog. Fail closed to Owner until Member 1 adds one.
export function canReadMoney(auth: AuthContext) {
  return auth.activeWorkspace?.role === "Owner";
}
export function assertCrmPermission(auth: AuthContext, entity: LiveEntity, deleting = false) {
  const permission = entity === "pipeline_stages" ? "pipelines.manage" : `${entity}.manage`;
  if (
    !auth.permissions.some((p) => p === permission) ||
    (deleting && !auth.permissions.includes("records.delete"))
  )
    throw new Error("You do not have permission to change these records.");
}
export const listSchema = z
  .object({
    entity: entitySchema,
    workspaceId: uuid.optional(),
    page: z.number().int().min(1).max(100000).default(1),
    pageSize: z.number().int().min(1).max(100).default(20),
    search: z.string().max(100).default(""),
    ownerId: uuid.optional(),
    companyId: uuid.optional(),
    contactId: uuid.optional(),
    pipelineId: uuid.optional(),
    stageId: uuid.optional(),
    closeFrom: date.optional(),
    closeTo: date.optional(),
    status: z.enum(["open", "won", "lost"]).optional(),
    sort: z.enum(["newest", "name", "close", "amount"]).default("newest"),
  })
  .strict()
  .refine(
    (v) => !v.closeFrom || !v.closeTo || v.closeFrom <= v.closeTo,
    "Close date range is reversed.",
  );
export type LiveListInput = z.input<typeof listSchema>;
export interface LivePage {
  rows: LiveRow[];
  total: number;
}
export interface CrmActivityEntry {
  id: number;
  actorId: string | null;
  actorName: string;
  action: string;
  createdAt: string;
}
export interface CrmReferences {
  companies: Pick<CompanyRow, "id" | "name">[];
  contacts: Pick<ContactRow, "id" | "full_name" | "company_id">[];
  pipelines: Pick<PipelineRow, "id" | "name" | "is_default">[];
  stages: Pick<PipelineStageRow, "id" | "pipeline_id" | "name" | "position" | "stage_type">[];
  members: { id: string; name: string }[];
  truncated: boolean;
}
export function safeCrmSearch(value: string) {
  return value
    .replace(/[^\p{L}\p{N}\s@.+_-]/gu, " ")
    .replace(/[%_]/g, " ")
    .trim()
    .slice(0, 80);
}
export function redactMoney<T extends { amount?: number | null }>(rows: T[], allowed: boolean) {
  return rows.map((row) => (allowed ? row : { ...row, amount: null }));
}
