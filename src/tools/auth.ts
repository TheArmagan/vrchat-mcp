/**
 * Hand-written auth tools, registered unconditionally.
 *
 * These are not VRChat API operations, so the tag / write / admin gates do not
 * apply — gating the tool that explains why nothing works would be perverse.
 */

import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { authStatus, getClient, logout, restartLogin, TwoFactorRequiredError } from '../vrchat/client.ts'
import { getBroker } from '../vrchat/twofactor.ts'

/** MCP results are text blocks; JSON keeps them machine-readable for the agent. */
function json(value: unknown) {
	return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] }
}

export function registerAuthTools(server: McpServer): void {
	server.registerTool(
		'vrchat_submitTwoFactorCode',
		{
			title: 'Submit VRChat two-factor code',
			description:
				'Supplies the two-factor code a parked VRChat login is waiting for. Call this after a tool reported "Login paused", passing the requestId it gave you and the code the user read from their email or authenticator app. On success, retry the original tool call.',
			inputSchema: z.object({
				requestId: z.string().describe('The requestId from the paused tool result or vrchat_authStatus.'),
				code: z.string().describe('The one-time code the user supplied. Never invent this.')
			}),
			annotations: { title: 'Submit VRChat two-factor code', readOnlyHint: false, openWorldHint: true }
		},
		async ({ requestId, code }) => {
			const result = getBroker().submitCode(requestId, code)
			if (!result.ok) {
				return json({
					ok: false,
					message: result.message,
					hint: 'Call vrchat_authStatus to see whether a request is pending, or retry the original tool to start a fresh login.'
				})
			}

			// The SDK single-flights `authenticate()` and every request awaits it,
			// so this call rides the very login we just unblocked and tells us
			// whether the code actually worked.
			const verified = await verifyLogin()

			return json({
				ok: verified.ok,
				message: verified.ok
					? 'Login succeeded; the session is now persisted.'
					: `Login did not complete: ${verified.message}`,
				nextStep: verified.ok
					? 'Retry the tool call that reported the paused login.'
					: 'Ask the user to re-read the code, then retry the original tool call to start a new login.'
			})
		}
	)

	server.registerTool(
		'vrchat_retryLogin',
		{
			title: 'Retry a stuck VRChat login',
			description:
				'Abandons a parked VRChat login and starts a fresh one. Use this when the login email turned out to be a new-location confirmation link rather than a six-digit code: VRChat only sends the code on the attempt *after* the link is opened, so the parked login can never succeed. Have the user open the link first, then call this. Also useful if a login has simply gone stale.',
			inputSchema: z.object({}),
			annotations: { title: 'Retry a stuck VRChat login', readOnlyHint: false, openWorldHint: true }
		},
		async () => {
			try {
				await restartLogin()
				return json({
					ok: true,
					state: 'authenticated',
					message: 'Login succeeded; the session is now persisted.',
					nextStep: 'Retry the tool call that reported the paused login.'
				})
			} catch (cause) {
				// Parking again is the expected outcome of the new-location flow:
				// the link is verified, so this attempt is the one VRChat answers
				// with an actual code.
				if (cause instanceof TwoFactorRequiredError) {
					return json({
						ok: true,
						state: 'awaiting_code',
						requestId: cause.pending.requestId,
						method: cause.pending.method,
						message: cause.message,
						nextStep:
							'A fresh code should now be in their inbox. Ask the user for it and call vrchat_submitTwoFactorCode with the requestId above.'
					})
				}

				return json({
					ok: false,
					state: 'failed',
					message: cause instanceof Error ? cause.message : String(cause),
					nextStep: 'Call vrchat_authStatus to see what the server thinks is wrong.'
				})
			}
		}
	)

	server.registerTool(
		'vrchat_authStatus',
		{
			title: 'VRChat auth status',
			description:
				'Reports VRChat authentication state (authenticated / awaiting a two-factor code / not configured), which environment gates are active, and the local rate limiter. Call this first whenever VRChat tools behave oddly.',
			inputSchema: z.object({}),
			annotations: { title: 'VRChat auth status', readOnlyHint: true, openWorldHint: false }
		},
		async () => json(await authStatus())
	)

	server.registerTool(
		'vrchat_logout',
		{
			title: 'VRChat logout',
			description:
				'Clears the persisted VRChat session so the next API call logs in again (and prompts for a two-factor code if the account needs one).',
			inputSchema: z.object({}),
			annotations: { title: 'VRChat logout', readOnlyHint: false, destructiveHint: false, openWorldHint: true }
		},
		async () => {
			await logout()
			return json({
				ok: true,
				message: 'Session cleared. The next VRChat tool call will log in from scratch.'
			})
		}
	)
}

/** Drives one authenticated read to find out whether the unblocked login took. */
async function verifyLogin(): Promise<{ ok: boolean; message: string }> {
	try {
		const { data, error } = await getClient().getCurrentUser({ throwOnError: false })
		if (data && typeof (data as { id?: unknown }).id === 'string') {
			return { ok: true, message: 'authenticated' }
		}
		return { ok: false, message: error?.message ?? 'VRChat did not return a user.' }
	} catch (cause) {
		return { ok: false, message: cause instanceof Error ? cause.message : String(cause) }
	}
}
