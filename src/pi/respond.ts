/** Host respond entry (handoff 2026-09-19: close wake → respond → applied).
 *
 *  After a managed delivery wakes the Pi session and the host (model or
 *  owner) reaches a decision, this module turns that decision into a
 *  consumer response (02 §2.5) and stages it in the target's durable
 *  response outbox. Both surfaces — the `/relay respond` owner command and
 *  the `relay_respond` model tool — share it, and both derive every identity
 *  field from durable state (the stored attention envelope + the consumer
 *  declaration), never from caller input: the model may pick action and
 *  reason, but cannot forge episode identity, revisions or ownership.
 *
 *  The response body is the watcher HostAck contract (watcher
 *  readResponses/applyResponse consume exactly these fields):
 *  episodeId + action identify the episode, expectedEpisodeRevision is the
 *  apply-time CAS, ownerBindingEpoch the owner match, until the snooze
 *  deadline for defer. */
import { newId } from '../protocol/canonical.js';
import { invariant } from '../protocol/errors.js';
import { listConsumerDeclarations } from '../consumer/index.js';

export const RESPOND_ACTIONS = ['received', 'investigating', 'defer', 'resolved', 'dismiss'] as const;
export type RespondAction = (typeof RESPOND_ACTIONS)[number];

export interface RespondSink {
  respond(input: {
    operationId: string;
    deliveryRef: string;
    responseType: string;
    schemaVersion: number;
    data: unknown;
  }): { responseId: string; state: 'target_staged' | 'source_recorded' | 'application_applied'; duplicate?: boolean };
  managedDeliveryPacket(deliveryRef: string): {
    deliveryRef: string;
    eventId: string;
    eventType: string;
    consumerProfileId: string;
    state: string;
    data: unknown;
  };
}

/** Attention envelope fields the response must carry back (watcher
 *  watcher.attention.v1 data contract, flattened). */
interface AttentionEnvelope {
  envelopeId: string;
  episodeId: string;
  episodeRevision: number;
  watchId: string;
  generation: number;
  ownerBindingEpoch: number;
}

function envelopeOf(data: unknown): AttentionEnvelope | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const raw = data as Record<string, unknown>;
  if (
    typeof raw.envelopeId !== 'string' ||
    typeof raw.episodeId !== 'string' ||
    typeof raw.episodeRevision !== 'number' ||
    typeof raw.watchId !== 'string' ||
    typeof raw.generation !== 'number' ||
    typeof raw.ownerBindingEpoch !== 'number'
  )
    return undefined;
  return {
    envelopeId: raw.envelopeId,
    episodeId: raw.episodeId,
    episodeRevision: raw.episodeRevision,
    watchId: raw.watchId,
    generation: raw.generation,
    ownerBindingEpoch: raw.ownerBindingEpoch,
  };
}

/** The wake-message details for a managed delivery, including the attention
 *  envelope projection when the event carries one (handoff §3 gap). */
export function managedDeliveryDetails(
  request: { event: { id: string; type: string; data?: unknown }; options: { scope: unknown; consumerProfileId: string } },
  deliveryRef: string,
): Record<string, unknown> {
  const details: Record<string, unknown> = {
    namespace: 'pi-relay/managed/delivery/v1',
    deliveryRef,
    eventId: request.event.id,
    eventType: request.event.type,
    scope: request.options.scope,
    consumerProfileId: request.options.consumerProfileId,
  };
  const envelope = envelopeOf(request.event.data);
  if (envelope) details.envelope = envelope;
  return details;
}

export function performRespond(
  sink: RespondSink,
  home: string,
  input: { deliveryRef: string; action: string; reason?: string; until?: string; operationId?: string },
): { responseId: string; state: string; duplicate?: boolean; responseType: string } {
  invariant(typeof input.deliveryRef === 'string' && input.deliveryRef.length > 0, 'invalid_payload');
  const action = input.action as RespondAction;
  invariant(RESPOND_ACTIONS.includes(action), 'invalid_payload');
  const reason = input.reason?.trim() || 'manual';
  let until: string | undefined;
  if (action === 'defer') {
    invariant(typeof input.until === 'string' && !Number.isNaN(Date.parse(input.until)), 'invalid_payload');
    until = input.until;
  }

  const packet = sink.managedDeliveryPacket(input.deliveryRef);
  // Delivery-state eligibility (recorded | submitted | held | pending) is
  // enforced by the facade respond() against the same row.
  const envelope = envelopeOf(packet.data);
  invariant(envelope, 'invalid_state'); // no attention envelope: nothing to respond to

  // responseType comes from the consumer declaration, never caller input.
  const declaration = listConsumerDeclarations(home).find(
    (x) => x.declaration?.profileId === packet.consumerProfileId,
  )?.declaration;
  const responseType = declaration?.responseTypes[0];
  invariant(responseType, 'invalid_state'); // consumer declares no response channel

  const data = {
    schemaVersion: 1,
    requestId: envelope.envelopeId,
    watchId: envelope.watchId,
    generation: envelope.generation,
    episodeId: envelope.episodeId,
    expectedEpisodeRevision: envelope.episodeRevision,
    action,
    reason,
    ...(until !== undefined ? { until } : {}),
    evidenceIds: [] as string[],
    ownerBindingEpoch: envelope.ownerBindingEpoch,
  };
  const result = sink.respond({
    operationId: input.operationId ?? newId('op'),
    deliveryRef: packet.deliveryRef,
    responseType,
    schemaVersion: 1,
    data,
  });
  return { ...result, responseType };
}
