export { ContextManager, type FitResult, groupTurns, type TurnGroup } from './context'
export { type Env, env, loadEnv, resetEnvCache } from './env'
export { describeError, GeminiAdapter, lastExplicitCacheError } from './gemini/adapter'
export {
  fromWireParts,
  toFunctionDeclarations,
  toGeminiSchema,
  toWireContents,
  type WireContent,
  type WirePart,
} from './gemini/wire'
export { hashRequest, sha256, stableStringify } from './hash'
export {
  type RunTurnOptions,
  runTurn,
  type ToolCallRecord,
  type TurnResult,
} from './loop'
export {
  type Memory,
  type MemorySource,
  type MemoryStore,
  matchCategories,
  recallMemories,
} from './memory'
export {
  estimateCostUsd,
  estimateUncachedCostUsd,
  formatUsd,
  type ModelPrice,
  PRICING,
  priceFor,
} from './pricing'
export {
  CACHE_PADDING_CONTEXT,
  SYSTEM_PROMPT,
  wrapContextSummary,
  wrapToolData,
  wrapUserMemory,
} from './prompt'
export {
  type Channel,
  type ConfirmFn,
  type ConfirmRequest,
  summarizeCall,
  type ToolContext,
  ToolRegistry,
  type ToolSpec,
  type ToolTier,
  truncate,
} from './registry'
export {
  canonicalizeMessages,
  estimateTokens,
  fixtureKey,
  ReplayAdapter,
  type ReplayOptions,
} from './replay'
export { stableSchema, zodToJsonSchema } from './schema'
export {
  clipForTrace,
  InMemoryTracer,
  NoopTracer,
  type RunFinish,
  type RunStatus,
  type TraceEventInput,
  type TraceEventRecord,
  type TraceEventType,
  type TraceRunHandle,
  type Tracer,
} from './trace'
export {
  type CanonicalMessage,
  type CanonicalResult,
  type ContentBlock,
  type JsonSchema,
  KakeiboError,
  type ProviderAdapter,
  type Role,
  type StopReason,
  type StreamRequest,
  type TextBlock,
  type ThoughtSummaryBlock,
  type ToolDef,
  type ToolResultBlock,
  type ToolUseBlock,
  type Usage,
} from './types'

import { GeminiAdapter as GeminiAdapterImpl } from './gemini/adapter'
import { ReplayAdapter as ReplayAdapterImpl } from './replay'
import type { ProviderAdapter as ProviderAdapterType } from './types'

/**
 * The adapter stack the app actually runs: the real Gemini client wrapped in
 * record/replay. In normal use the wrapper is a passthrough; RECORD=1 and
 * REPLAY=1 switch it on (spec 8.2).
 */
export function createAdapter(options?: { fixtureDir?: string }): ProviderAdapterType {
  return new ReplayAdapterImpl(new GeminiAdapterImpl(), options ?? {})
}
