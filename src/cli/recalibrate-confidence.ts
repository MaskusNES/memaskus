import Database from "better-sqlite3";
import { loadConfig } from "../config.js";
import { nowIso } from "../shared/time.js";

type NodeRow = {
  id: string;
  type: string;
  content: string;
  confidence: number;
  status: string;
  metadata_json: string;
};

type CandidateRow = {
  id: string;
  confidence: number;
  metadata_json: string;
};

function clamp(value: number): number {
  return Number(Math.min(0.96, Math.max(0.55, value)).toFixed(2));
}

function recalibrateNode(row: NodeRow): { confidence: number; reason: string } | null {
  if (row.confidence !== 0.82) {
    return null;
  }

  const metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
  const content = row.content.toLowerCase();
  const userText = String(metadata.disagreement_text ?? "").toLowerCase();
  const inferredReason = String(metadata.inferred_reason ?? "");
  const values = Array.isArray(metadata.demonstrated_values) ? metadata.demonstrated_values : [];

  if (row.type === "Preference") {
    let confidence = 0.66;
    const reasons: string[] = ["legacy_preference_recalibration"];

    if (inferredReason.length > 60) {
      confidence += 0.04;
      reasons.push("reasoned_inference");
    }
    if (inferredReason.length > 140) {
      confidence += 0.02;
      reasons.push("detailed_reason");
    }

    confidence += Math.min(0.07, values.length * 0.02);
    if (values.length > 0) {
      reasons.push(`values:${values.length}`);
    }

    if (/предпоч|хочу|нужно|долж|важно|давай|let'?s|i want|i prefer|must|should/iu.test(userText)) {
      confidence += 0.04;
      reasons.push("explicit_user_intent");
    } else if (/can we|можно|почему|why|did you|ты все/iu.test(userText)) {
      confidence += 0.02;
      reasons.push("question_or_check_signal");
    }

    if (/предпочитает|предпочитаю|prefers|prefer/iu.test(content)) {
      confidence += 0.04;
      reasons.push("preference_wording");
    } else if (/хочет|ожидает|wants|expects/iu.test(content)) {
      confidence += 0.03;
      reasons.push("intent_wording");
    } else if (/допускает|подходит|accepts|comfortable/iu.test(content)) {
      confidence += 0.01;
      reasons.push("compatibility_wording");
    }

    if (/явн|обязательн|перед запись|conflict|конфликт|confirmation|подтвержд/iu.test(content)) {
      confidence += 0.03;
      reasons.push("strong_process_constraint");
    }

    if (/неясн|unclear|может|may/iu.test(content)) {
      confidence -= 0.03;
      reasons.push("weaker_or_clarification_scope");
    }

    let nextConfidence = clamp(confidence);
    if (nextConfidence === row.confidence) {
      nextConfidence = /предпочитает|реально доступны|явно|глобально/iu.test(row.content) ? 0.83 : 0.81;
      reasons.push("legacy_tie_breaker");
    }

    return { confidence: nextConfidence, reason: reasons.join(",") };
  }

  if (row.type === "Fact") {
    let confidence = 0.78;
    const reasons = ["legacy_fact_recalibration"];

    if (/[A-Z]:\\|\.pptx|\.html|\.js|email|@|PowerPoint|LibreOffice|PyMuPDF|fitz/iu.test(row.content)) {
      confidence += 0.07;
      reasons.push("specific_artifacts_or_paths");
    }
    if (row.content.length > 220) {
      confidence += 0.04;
      reasons.push("detailed_statement");
    }
    if (metadata.domain || metadata.topic) {
      confidence += 0.02;
      reasons.push("domain_metadata");
    }

    let nextConfidence = clamp(confidence);
    if (nextConfidence === row.confidence) {
      nextConfidence = row.content.length > 180 ? 0.83 : 0.81;
      reasons.push("legacy_tie_breaker");
    }

    return { confidence: nextConfidence, reason: reasons.join(",") };
  }

  return null;
}

const db = new Database(process.env.MEMORY_DB_PATH ?? loadConfig().databasePath);
const now = nowIso();
const nodeRows = db.prepare("SELECT * FROM nodes WHERE confidence = 0.82").all() as NodeRow[];
const updateNode = db.prepare("UPDATE nodes SET confidence = ?, metadata_json = ?, updated_at = ? WHERE id = ?");
const updateCandidate = db.prepare("UPDATE candidates SET confidence = ?, metadata_json = ?, updated_at = ? WHERE id = ?");
const candidateById = db.prepare("SELECT id, confidence, metadata_json FROM candidates WHERE id = ?") as Database.Statement<
  [string],
  CandidateRow | undefined
>;
const candidateRows = db.prepare("SELECT id, confidence, metadata_json FROM candidates WHERE confidence = 0.82").all() as CandidateRow[];

let nodes = 0;
let candidates = 0;
const candidateConfidenceById = new Map<string, { confidence: number; sourceNodeId: string }>();

db.transaction(() => {
  for (const row of nodeRows) {
    const recalibrated = recalibrateNode(row);
    if (!recalibrated) {
      continue;
    }

    const metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
    metadata.previous_confidence = row.confidence;
    metadata.confidence_recalibrated_at = now;
    metadata.confidence_source = "recalibrated_legacy";
    metadata.confidence_recalibration_reason = recalibrated.reason;
    updateNode.run(recalibrated.confidence, JSON.stringify(metadata), now, row.id);
    nodes += 1;

    const candidateId = metadata.approved_from_candidate_id;
    if (typeof candidateId === "string") {
      candidateConfidenceById.set(candidateId, { confidence: recalibrated.confidence, sourceNodeId: row.id });
    }
  }

  for (const [candidateId, recalibrated] of candidateConfidenceById.entries()) {
    const row = candidateById.get(candidateId);
    if (!row || row.confidence !== 0.82) {
      continue;
    }

    const metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
    metadata.previous_confidence = row.confidence;
    metadata.confidence_recalibrated_at = now;
    metadata.confidence_source = "recalibrated_legacy";
    metadata.confidence_recalibrated_from_node_id = recalibrated.sourceNodeId;
    updateCandidate.run(recalibrated.confidence, JSON.stringify(metadata), now, row.id);
    candidates += 1;
  }

  for (const row of candidateRows) {
    if (candidateConfidenceById.has(row.id)) {
      continue;
    }

    const metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
    metadata.previous_confidence = row.confidence;
    metadata.confidence_recalibrated_at = now;
    metadata.confidence_source = "recalibrated_legacy_orphan_candidate";
    updateCandidate.run(0.78, JSON.stringify(metadata), now, row.id);
    candidates += 1;
  }
})();

db.close();

console.log(JSON.stringify({ nodes, candidates }, null, 2));
