// TrustGate: the confidence and human-in-the-loop routing math behind a
// post guardrail, ported from the Python TrustGate module of a production
// decision-integrity platform (rmfx-v2, backend/trustgate/). Pure functions
// over plain objects, so an adopter can use any one of them alone or wire
// the whole thing in as `guardrails.post` with `trustGatePostGuardrail`.
//
// What is ported, and what was changed on the way:
//
//   groundFields       lexical source grounding: is each extracted value
//                      findable in the source text? This is the Python
//                      original's known weak point — a lowercase substring
//                      match with numeric normalization and a structured-
//                      metadata fallback. It catches fabricated values and
//                      misses paraphrase. `ground` is pluggable for that
//                      reason: drop in an embedding or NLI check and the
//                      rest of the pipeline is unchanged.
//   checkBusinessRules range, allowed-values and custom-validator rules.
//   computeConfidence  the weighted blend (llm 0.20, schema 0.15, grounding
//                      0.30, rules 0.15, judge 0.20; judge weight
//                      redistributed when absent) and the level ladder.
//                      Numerically identical to the Python original for the
//                      cases in trustgate.test.ts. One faithful quirk: the
//                      judge's hallucination and unsupported-claim penalties
//                      are RECORDED but not applied to the overall score in
//                      the original, and they are not applied here either;
//                      the judge's factual accuracy already enters through
//                      its weight. Only `penalties` (the original's
//                      additional_factors) move the number.
//   routeToHitl        confidence against a per-document-type threshold with
//                      risk and value adjustments, and the priority ladder.
//                      MECHANISM ported exactly; DEFAULTS deliberately not.
//                      The original's default adjustments are negative
//                      (HIGH risk -0.15, value over 10,000 -0.10), which
//                      LOWERS the bar for high-stakes items so fewer of them
//                      reach a human. That reads like an inverted sign that
//                      nobody tuned, and it is not a default this package
//                      will ship. The defaults here raise the bar instead
//                      (HIGH risk +0.10, value over 10,000 +0.10). Pass the
//                      original numbers explicitly if you want them; the
//                      parity tests do exactly that.

import type { GuardrailHook, GuardrailVerdict, PostGuardrailContext } from "./guardrails.js";

// ── Source grounding ─────────────────────────────────────────────────────────

export interface FieldGrounding {
  field: string;
  value: unknown;
  grounded: boolean;
  /** 1.0 exact, 0.9 numeric match after normalization, 0.95 metadata match, 0 otherwise. */
  confidence: number;
  /** How it was found, for the audit trail. */
  evidence: string[];
  /** Character offset of an exact match in the source text. */
  offset?: number;
}

export interface GroundingOptions {
  /** Structured values known independently of the model (form fields, headers). */
  metadata?: Record<string, unknown>;
  /** Fields to check. Default: every top-level key of the output. */
  fields?: string[];
  /** Exact substring only; no numeric normalization, no metadata fallback. */
  exactOnly?: boolean;
}

function normalizeNumber(s: string): string {
  return s.replace(/[,$%\s]/g, "");
}

function isNumeric(s: string): boolean {
  const n = normalizeNumber(s);
  return n.length > 0 && Number.isFinite(Number(n));
}

/** Lexical grounding of one value against the source text. */
export function groundValue(
  field: string,
  value: unknown,
  sourceText: string,
  opts: GroundingOptions = {},
): FieldGrounding {
  const valueStr = value === null || value === undefined ? "" : String(value);
  const evidence: string[] = [];
  if (valueStr === "") {
    return { field, value, grounded: false, confidence: 0, evidence: ["empty value"] };
  }
  const haystack = sourceText.toLowerCase();
  const needle = valueStr.toLowerCase();
  const idx = haystack.indexOf(needle);
  if (idx !== -1) {
    evidence.push(`exact match at offset ${idx}`);
    return { field, value, grounded: true, confidence: 1, evidence, offset: idx };
  }
  if (!opts.exactOnly) {
    if (isNumeric(valueStr) && normalizeNumber(haystack).includes(normalizeNumber(needle))) {
      evidence.push("numeric match after normalization");
      return { field, value, grounded: true, confidence: 0.9, evidence };
    }
    const meta = opts.metadata?.[field];
    if (meta !== undefined && meta !== null) {
      const m = String(meta);
      if (m === valueStr || m.toLowerCase() === needle) {
        evidence.push("matched structured metadata");
        return { field, value, grounded: true, confidence: 0.95, evidence };
      }
    }
  }
  return { field, value, grounded: false, confidence: 0, evidence };
}

export type Grounder = (
  field: string,
  value: unknown,
  sourceText: string,
  opts: GroundingOptions,
) => FieldGrounding | Promise<FieldGrounding>;

/** Ground every chosen field of an output. `ground` defaults to the lexical check. */
export async function groundFields(
  output: Record<string, unknown>,
  sourceText: string,
  opts: GroundingOptions & { ground?: Grounder } = {},
): Promise<FieldGrounding[]> {
  const ground = opts.ground ?? groundValue;
  const fields = opts.fields ?? Object.keys(output);
  const out: FieldGrounding[] = [];
  for (const field of fields) {
    if (!(field in output)) continue;
    out.push(await ground(field, output[field], sourceText, opts));
  }
  return out;
}

// ── Business rules ───────────────────────────────────────────────────────────

export type BusinessRule = {
  id: string;
  field: string;
  description?: string;
} & (
  | { range: { min?: number; max?: number } }
  | { allowedValues: readonly unknown[] }
  | { validate: (value: unknown) => boolean }
);

export interface RuleResult {
  ruleId: string;
  field: string;
  value: unknown;
  passed: boolean;
  reason?: string;
}

/** Apply every rule whose field is present in the output. */
export function checkBusinessRules(
  output: Record<string, unknown>,
  rules: readonly BusinessRule[],
): RuleResult[] {
  const results: RuleResult[] = [];
  for (const rule of rules) {
    if (!(rule.field in output)) continue;
    const value = output[rule.field];
    if ("range" in rule) {
      const n = typeof value === "number" ? value : Number(normalizeNumber(String(value)));
      if (!Number.isFinite(n)) {
        results.push({
          ruleId: rule.id,
          field: rule.field,
          value,
          passed: false,
          reason: `value cannot be read as a number: ${String(value)}`,
        });
      } else if (rule.range.min !== undefined && n < rule.range.min) {
        results.push({
          ruleId: rule.id,
          field: rule.field,
          value,
          passed: false,
          reason: `value ${n} below minimum ${rule.range.min}`,
        });
      } else if (rule.range.max !== undefined && n > rule.range.max) {
        results.push({
          ruleId: rule.id,
          field: rule.field,
          value,
          passed: false,
          reason: `value ${n} above maximum ${rule.range.max}`,
        });
      } else {
        results.push({ ruleId: rule.id, field: rule.field, value, passed: true });
      }
    } else if ("allowedValues" in rule) {
      const ok = rule.allowedValues.includes(value);
      results.push({
        ruleId: rule.id,
        field: rule.field,
        value,
        passed: ok,
        ...(ok ? {} : { reason: `value ${JSON.stringify(value)} not in allowed values` }),
      });
    } else {
      let ok = false;
      let reason: string | undefined;
      try {
        ok = rule.validate(value) === true;
        if (!ok) reason = "custom validation failed";
      } catch (err) {
        reason = `validation error: ${err instanceof Error ? err.message : String(err)}`;
      }
      results.push({
        ruleId: rule.id,
        field: rule.field,
        value,
        passed: ok,
        ...(reason ? { reason } : {}),
      });
    }
  }
  return results;
}

// ── Confidence ───────────────────────────────────────────────────────────────

export type ConfidenceLevel = "VERY_HIGH" | "HIGH" | "MEDIUM" | "LOW" | "VERY_LOW";

export interface ConfidencePenalty {
  reason: string;
  penalty: number;
}

export interface ConfidenceScore {
  overall: number;
  level: ConfidenceLevel;
  llm: number;
  schema: number;
  grounding: number;
  rules: number;
  judge: number | null;
  penalties: ConfidencePenalty[];
}

export interface JudgeSignal {
  /** 0..1, the judge's factual accuracy for the output. */
  factualAccuracy: number;
  hallucinationDetected?: boolean;
  unsupportedClaims?: number;
}

export interface ConfidenceInputs {
  /** The generating model's self-reported confidence, 0..1. */
  llmConfidence: number;
  /** Schema outcome. `warnings` are non-fatal validation messages. Omit when unknown. */
  schema?: { ok: boolean; warnings?: number };
  grounding?: readonly FieldGrounding[];
  rules?: readonly RuleResult[];
  judge?: JudgeSignal;
  /** Extra factors. Negative numbers are applied to the overall score and recorded. */
  penalties?: Record<string, number>;
}

export const CONFIDENCE_WEIGHTS = {
  llm: 0.2,
  schema: 0.15,
  grounding: 0.3,
  rules: 0.15,
  judge: 0.2,
} as const;

export function confidenceLevel(overall: number): ConfidenceLevel {
  if (overall >= 0.95) return "VERY_HIGH";
  if (overall >= 0.85) return "HIGH";
  if (overall >= 0.7) return "MEDIUM";
  if (overall >= 0.5) return "LOW";
  return "VERY_LOW";
}

export function computeConfidence(inputs: ConfidenceInputs): ConfidenceScore {
  const penalties: ConfidencePenalty[] = [];
  let schema = 1;
  let grounding = 1;
  let rules = 1;
  let judge: number | null = null;

  if (inputs.schema) {
    if (!inputs.schema.ok) {
      schema = 0;
      penalties.push({ reason: "Schema validation failed", penalty: 1 });
    } else if (inputs.schema.warnings && inputs.schema.warnings > 0) {
      schema = Math.max(0.5, 1 - inputs.schema.warnings * 0.1);
      penalties.push({ reason: `${inputs.schema.warnings} schema warnings`, penalty: 1 - schema });
    }
  }

  if (inputs.grounding && inputs.grounding.length > 0) {
    const total = inputs.grounding.length;
    const groundedCount = inputs.grounding.filter((g) => g.grounded).length;
    grounding = groundedCount / total;
    if (grounding < 1) {
      penalties.push({
        reason: `${total - groundedCount} fields not grounded in source`,
        penalty: 1 - grounding,
      });
    }
    const avg = inputs.grounding.reduce((s, g) => s + g.confidence, 0) / total;
    grounding = (grounding + avg) / 2;
  }

  if (inputs.rules && inputs.rules.length > 0) {
    const total = inputs.rules.length;
    const passed = inputs.rules.filter((r) => r.passed).length;
    rules = passed / total;
    if (rules < 1) {
      penalties.push({ reason: `${total - passed} business rules failed`, penalty: 1 - rules });
    }
  }

  if (inputs.judge) {
    judge = inputs.judge.factualAccuracy;
    if (inputs.judge.hallucinationDetected) {
      penalties.push({ reason: "Judge detected hallucination", penalty: 0.5 });
    }
    if (inputs.judge.unsupportedClaims && inputs.judge.unsupportedClaims > 0) {
      penalties.push({
        reason: `Judge found ${inputs.judge.unsupportedClaims} unsupported claims`,
        penalty: 0.3,
      });
    }
  }

  const w = CONFIDENCE_WEIGHTS;
  let weighted =
    inputs.llmConfidence * w.llm + schema * w.schema + grounding * w.grounding + rules * w.rules;
  if (judge !== null) {
    weighted += judge * w.judge;
  } else {
    weighted = weighted / (1 - w.judge);
  }

  let overall = weighted;
  if (inputs.penalties) {
    for (const [reason, value] of Object.entries(inputs.penalties)) {
      if (typeof value === "number" && value < 0) {
        overall += value;
        penalties.push({ reason, penalty: Math.abs(value) });
      }
    }
  }
  overall = Math.max(0, Math.min(1, overall));

  return {
    overall,
    level: confidenceLevel(overall),
    llm: inputs.llmConfidence,
    schema,
    grounding,
    rules,
    judge,
    penalties,
  };
}

// ── HITL routing ─────────────────────────────────────────────────────────────

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH";
export type ReviewPriority = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface ValueAdjustment {
  minValue: number;
  /** Exclusive. Use Infinity for an open top band. */
  maxValue: number;
  adjustment: number;
}

export interface HitlThreshold {
  /** Confidence below this routes to a human. Default 0.85. */
  baseThreshold?: number;
  /** Added to the base threshold by risk level. */
  riskAdjustments?: Partial<Record<RiskLevel, number>>;
  /** Added to the base threshold by the first band the value falls in. */
  valueAdjustments?: readonly ValueAdjustment[];
}

/**
 * Higher stakes, higher bar. These are NOT the Python original's defaults;
 * see the header comment. `ORIGINAL_ADJUSTMENTS` has those.
 */
export const DEFAULT_RISK_ADJUSTMENTS: Record<RiskLevel, number> = {
  LOW: 0,
  MEDIUM: 0.05,
  HIGH: 0.1,
};
export const DEFAULT_VALUE_ADJUSTMENTS: readonly ValueAdjustment[] = [
  { minValue: 0, maxValue: 1_000, adjustment: 0 },
  { minValue: 1_000, maxValue: 10_000, adjustment: 0.05 },
  { minValue: 10_000, maxValue: Number.POSITIVE_INFINITY, adjustment: 0.1 },
];
/** The Python original's defaults, kept for parity tests and for anyone who needs the exact old behaviour. */
export const ORIGINAL_ADJUSTMENTS: Required<
  Pick<HitlThreshold, "riskAdjustments" | "valueAdjustments">
> = {
  riskAdjustments: { LOW: 0, MEDIUM: -0.05, HIGH: -0.15 },
  valueAdjustments: [
    { minValue: 0, maxValue: 1_000, adjustment: 0 },
    { minValue: 1_000, maxValue: 10_000, adjustment: -0.05 },
    { minValue: 10_000, maxValue: Number.POSITIVE_INFINITY, adjustment: -0.1 },
  ],
};

export const DEFAULT_HITL_THRESHOLD = 0.85;

export interface HitlContext {
  /** Used to pick a threshold config; "Default threshold" when none matches. */
  documentType: string;
  riskLevel?: RiskLevel;
  /** Monetary or other stake size, in the units the value bands use. */
  estimatedValue?: number;
  /** Guardrail failures already known, for the routing reason. */
  failures?: readonly string[];
}

export interface HitlDecision {
  route: boolean;
  priority: ReviewPriority;
  threshold: number;
  thresholdReason: string;
  routingReason: string;
  confidence: ConfidenceScore;
  failures: string[];
  documentType: string;
  riskLevel: RiskLevel;
  estimatedValue?: number;
}

export interface HitlOptions {
  /** Per document type. A type with no entry uses `defaultThreshold` and no adjustments. */
  thresholds?: Record<string, HitlThreshold>;
  defaultThreshold?: number;
}

export function routeToHitl(
  confidence: ConfidenceScore,
  ctx: HitlContext,
  opts: HitlOptions = {},
): HitlDecision {
  const riskLevel = ctx.riskLevel ?? "MEDIUM";
  const cfg = opts.thresholds?.[ctx.documentType];
  let threshold: number;
  let thresholdReason: string;
  if (!cfg) {
    threshold = opts.defaultThreshold ?? DEFAULT_HITL_THRESHOLD;
    thresholdReason = `Default threshold (no config for ${ctx.documentType})`;
  } else {
    threshold = cfg.baseThreshold ?? DEFAULT_HITL_THRESHOLD;
    thresholdReason = `Base threshold for ${ctx.documentType}`;
    const risk = (cfg.riskAdjustments ?? DEFAULT_RISK_ADJUSTMENTS)[riskLevel] ?? 0;
    threshold += risk;
    if (risk !== 0) thresholdReason += `, risk adjustment ${signed(risk)}`;
    if (ctx.estimatedValue !== undefined) {
      const bands = cfg.valueAdjustments ?? DEFAULT_VALUE_ADJUSTMENTS;
      const band = bands.find(
        (b) => b.minValue <= ctx.estimatedValue! && ctx.estimatedValue! < b.maxValue,
      );
      if (band && band.adjustment !== 0) {
        threshold += band.adjustment;
        thresholdReason += `, value adjustment ${signed(band.adjustment)}`;
      }
    }
  }
  threshold = Math.max(0, Math.min(1, threshold));

  const route = confidence.overall < threshold;
  const failures = [...(ctx.failures ?? [])];
  let routingReason = route
    ? `Confidence ${confidence.overall.toFixed(2)} below threshold ${threshold.toFixed(2)}`
    : `Confidence ${confidence.overall.toFixed(2)} meets threshold ${threshold.toFixed(2)}`;
  if (route && failures.length > 0) routingReason += `. Failed: ${failures.slice(0, 3).join(", ")}`;

  let priority: ReviewPriority = "LOW";
  if (route) {
    if (confidence.overall < 0.5) priority = "CRITICAL";
    else if (confidence.overall < 0.7) priority = "HIGH";
    else if (
      riskLevel === "HIGH" ||
      (ctx.estimatedValue !== undefined && ctx.estimatedValue > 10_000)
    )
      priority = "HIGH";
    else priority = "MEDIUM";
  }

  return {
    route,
    priority,
    threshold,
    thresholdReason,
    routingReason,
    confidence,
    failures,
    documentType: ctx.documentType,
    riskLevel,
    ...(ctx.estimatedValue !== undefined ? { estimatedValue: ctx.estimatedValue } : {}),
  };
}

function signed(n: number): string {
  return `${n >= 0 ? "+" : "-"}${Math.abs(n).toFixed(2)}`;
}

// ── The composed post guardrail ──────────────────────────────────────────────

export interface TrustGateOptions<O = unknown> {
  /** The source the output must be grounded in. Return undefined to skip grounding. */
  sourceText?: (ctx: PostGuardrailContext & { output: O }) => string | undefined;
  /** Structured values the grounder may fall back to. */
  metadata?: (ctx: PostGuardrailContext & { output: O }) => Record<string, unknown> | undefined;
  /** Fields to ground. Default: every top-level key. */
  fields?: string[];
  grounder?: Grounder;
  rules?:
    | readonly BusinessRule[]
    | ((ctx: PostGuardrailContext & { output: O }) => readonly BusinessRule[]);
  /** The generating model's self-reported confidence. Default 1 (no opinion). */
  llmConfidence?: (ctx: PostGuardrailContext & { output: O }) => number;
  judge?: (ctx: PostGuardrailContext & { output: O }) => JudgeSignal | undefined;
  penalties?: (ctx: PostGuardrailContext & { output: O }) => Record<string, number> | undefined;
  documentType: string | ((ctx: PostGuardrailContext & { output: O }) => string);
  riskLevel?: RiskLevel | ((ctx: PostGuardrailContext & { output: O }) => RiskLevel);
  estimatedValue?: (ctx: PostGuardrailContext & { output: O }) => number | undefined;
  thresholds?: Record<string, HitlThreshold>;
  defaultThreshold?: number;
  /**
   * What a routed decision becomes. "block" (default): throw GuardrailError
   * with the decision in `detail`, so the caller sends the object to a human
   * queue. "allow": let the call through and only ledger the decision; use
   * this while calibrating thresholds against real traffic.
   */
  onRoute?: "block" | "allow";
}

export interface TrustGateDetail {
  decision: HitlDecision;
  grounding: FieldGrounding[];
  rules: RuleResult[];
}

/**
 * Build a `guardrails.post` hook: ground the output, check the rules, blend
 * the confidence, and route. Every verdict carries the full decision in
 * `detail`, so the ledger row explains itself.
 */
export function trustGatePostGuardrail<O = Record<string, unknown>>(
  opts: TrustGateOptions<O>,
): GuardrailHook<PostGuardrailContext> {
  return async (raw) => {
    const ctx = raw as PostGuardrailContext & { output: O };
    const output = (ctx.output ?? {}) as Record<string, unknown>;
    const sourceText = opts.sourceText?.(ctx);
    const grounding =
      sourceText !== undefined
        ? await groundFields(output, sourceText, {
            metadata: opts.metadata?.(ctx),
            fields: opts.fields,
            ground: opts.grounder,
          })
        : [];
    const ruleList = typeof opts.rules === "function" ? opts.rules(ctx) : (opts.rules ?? []);
    const rules = checkBusinessRules(output, ruleList);
    const confidence = computeConfidence({
      llmConfidence: opts.llmConfidence?.(ctx) ?? 1,
      schema: { ok: true },
      grounding,
      rules,
      judge: opts.judge?.(ctx),
      penalties: opts.penalties?.(ctx),
    });
    const failures = [
      ...grounding
        .filter((g) => !g.grounded)
        .map((g) => `field not grounded in source: ${g.field}`),
      ...rules
        .filter((r) => !r.passed)
        .map((r) => `rule ${r.ruleId} failed: ${r.reason ?? ""}`.trim()),
    ];
    const decision = routeToHitl(
      confidence,
      {
        documentType:
          typeof opts.documentType === "function" ? opts.documentType(ctx) : opts.documentType,
        riskLevel: typeof opts.riskLevel === "function" ? opts.riskLevel(ctx) : opts.riskLevel,
        estimatedValue: opts.estimatedValue?.(ctx),
        failures,
      },
      { thresholds: opts.thresholds, defaultThreshold: opts.defaultThreshold },
    );
    const detail: TrustGateDetail = { decision, grounding, rules };
    if (decision.route && (opts.onRoute ?? "block") === "block") {
      return {
        action: "block",
        reason: decision.routingReason,
        detail: detail as unknown as Record<string, unknown>,
      };
    }
    // An allow still ledgers the whole decision: the usage row explains why
    // this one did not go to a human.
    return {
      action: "allow",
      reason: decision.routingReason,
      detail: detail as unknown as Record<string, unknown>,
    } satisfies GuardrailVerdict;
  };
}
