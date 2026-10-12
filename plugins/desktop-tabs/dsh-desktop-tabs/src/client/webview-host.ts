/**
 * The remote-guest hosting surface the client half drives.
 *
 * Shared by the view layer and the notification relay: only the operations the
 * relay needs are declared here (the view-layer element type is a separate,
 * more complete `<webview>` element shape). The relay deliberately never reads
 * guest storage or navigates the guest — it only evaluates script.
 */
export interface RemoteWebview {
  /** Evaluate `code` in the guest's main world; resolves with the structured-cloneable result. */
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>
}