/** The executor owns this decision. An already-observed tool result must not acquire a second wake path. */
export async function relayCompletion(publisher, { event, observedAsToolResult, notificationOwner }) {
  if (observedAsToolResult) return { skipped: 'already-observed-tool-result' };
  if (notificationOwner !== 'relay') return { skipped: 'another-notification-owner' };
  return publisher.publish(event);
}
