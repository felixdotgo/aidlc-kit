export type WorkStatus = 'INBOX' | 'READY' | 'DOING' | 'WAITING' | 'DONE';
export type WorkClassification = 'ACTIONABLE' | 'CONTEXT' | 'DECISION' | 'QUESTION' | 'REFERENCE' | 'NOISE';
export type WorkOutcome = 'CREATE' | 'UPDATE' | 'APPEND_CONTEXT' | 'IGNORE' | 'AMBIGUOUS';
export interface WorkItemRef { provider: string; id: string; url: string }
export interface SourceEnvelope { source: string; externalId: string | null; threadId: string | null; author: string | null; timestamp: string | null; url: string | null; body: string }
export interface WorkItem {
  schemaVersion: 1; title: string; summary: string; expectedOutcome: string; nextAction: string; status: WorkStatus;
  priority: string | null; due: string | null; project: string | null; aidlcTaskId: string | null; sources: SourceEnvelope[];
  dedupe: { externalIds: string[]; threadIds: string[]; references: string[]; keywords: string[] };
}
export interface WorkCheckpoint {
  schemaVersion: 1; goal: string; state: string | null; hypothesis: string | null; nextAction: string; capturedAt: string;
  completed: string[]; observations: string[]; blockers: string[]; files: string[]; links: string[];
}
export type PersonalWorkConfig = { enabled: false } | {
  enabled: true; provider: 'local'; capture: { preserveRawSource: boolean; autoReady: boolean };
  limits: { doing: number; resumeContextChars: number; searchItems: number; contextRecords: number; intakeMessages: number };
};
