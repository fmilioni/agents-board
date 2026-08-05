/**
 * Real-time event contract — the single source of truth shared by the backend
 * `notify()` (which writes these through `pg_notify`) and the web client (which
 * receives them over WebSocket).
 */
export type AbEvent
  = | { type: 'card.changed', projectId: string, cardId: string, cardKey?: string }
    | { type: 'card.deleted', projectId: string, cardId: string }
    | { type: 'comment.added', projectId: string, cardId: string, commentId: string }
    | { type: 'comment.updated', projectId: string, cardId: string, commentId: string }
    | { type: 'comment.deleted', projectId: string, cardId: string, commentId: string }
    | { type: 'comment.read', projectId: string, cardId: string }
    | { type: 'comment.handled', projectId: string, cardId: string }
    | { type: 'commit.changed', projectId: string, cardId: string, commitId: string }
    | { type: 'sprint.changed', projectId: string, sprintId: string }
    | { type: 'sprint.deleted', projectId: string, sprintId: string }
    | { type: 'doc.changed', projectId: string, docId: string }
    | { type: 'doc.deleted', projectId: string, docId: string }
    | { type: 'project.changed', projectId: string }
    | { type: 'project.deleted', projectId: string }
    | { type: 'inbox.changed', projectId: string, intakeId: string }
    | { type: 'inbox.deleted', projectId: string, intakeId: string }

/** Control frame the server sends right after a client connects. */
export interface AbHello {
  type: 'hello'
  projectId: string
}

/** Any message a WebSocket client can receive on the project channel. */
export type AbSocketMessage = AbEvent | AbHello
