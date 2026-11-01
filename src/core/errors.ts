/** An error whose message is meant for the person at the keyboard (or the agent), not a stack trace. */
export class UserError extends Error {
  override name = "UserError";
}
