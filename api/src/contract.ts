import { z } from 'zod'

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly extra = {}) {
    super(message)
  }
}
export function invalid(message: string): never { throw new ApiError(400, 'INVALID_REQUEST', message) }
export function missing(): never { throw new ApiError(404, 'NOT_FOUND', '资源不存在或已删除。') }
export function conflict(): never { throw new ApiError(409, 'VERSION_CONFLICT', '记录已更新，请重新加载并核对本地改动。') }
export function stateConflict(): never { throw new ApiError(409, 'INVALID_CASE_STATE', '当前案例状态无法执行此操作。') }

export const uuid = z.uuid().transform(value => value.toLowerCase())
export const version = z.number().int().positive().max(2147483647)
export const side = z.enum(['source', 'test_requirement'])
export type Side = z.infer<typeof side>
const status = z.enum(['draft', 'published', 'withdrawn'])
export const category = z.enum(['功能', '性能', '接口', '可靠性／安全性', '余量', '边界', '数据处理', '恢复', '强度', '其他'])
export const datasetInput = z.object({ name: z.string().trim().min(1), note: z.string().default('') })
export const caseInput = z.object({
  title: z.string().trim(), testObject: z.string().trim(), categories: z.array(category),
  interfaceType: z.string(), scenario: z.string(), keywords: z.string(), conditions: z.string(), note: z.string(),
  sourceSliceIds: z.array(uuid), testRequirementSliceIds: z.array(uuid),
})
export type CaseInput = z.infer<typeof caseInput>
export const filters = z.object({
  q: z.string().optional(), status: status.optional(), category: category.optional(),
  testObject: z.string().optional(), interfaceType: z.string().optional(), scenario: z.string().optional(),
  updatedSince: z.iso.datetime({ offset: true }).optional(),
})
export type Filters = z.infer<typeof filters>
export const pagination = z.object({
  page: z.coerce.number().int().positive().max(2147483647).default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
})
export const searchInput = z.object({ query: z.string().trim().min(1), limit: z.number().int().positive().optional() })
export const normalize = (text: string) => text.normalize('NFKC').trim().toLowerCase()

export function read<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) invalid(parsed.error.issues.map(issue => issue.path.join('.') || '请求内容').join('、') + ' 无效。')
  return parsed.data
}
