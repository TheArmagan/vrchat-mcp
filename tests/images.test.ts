/**
 * Host handling for `vrchat_getImage`.
 *
 * This tool fetches a caller-supplied URL while holding a VRChat session, which
 * is a request-forgery primitive unless the target is constrained. These tests
 * pin the constraint.
 */

import { describe, expect, test } from 'bun:test'

import { isAllowedHost, isApiHost } from '../src/tools/images.ts'

describe('host allowlist', () => {
	test('accepts VRChat hosts and their subdomains', () => {
		for (const host of ['api.vrchat.cloud', 'assets.vrchat.com', 'files.vrchat.cloud']) {
			expect(isAllowedHost(host)).toBe(true)
		}
	})

	test('rejects everything else', () => {
		for (const host of ['evil.example.com', 'localhost', '169.254.169.254', 'vrchat.cloud.evil.com']) {
			expect(isAllowedHost(host)).toBe(false)
		}
	})

	test('a lookalike suffix does not slip through', () => {
		// `endsWith('.vrchat.cloud')` is the check, so the dot matters: without
		// it, `notvrchat.cloud` would pass.
		expect(isAllowedHost('notvrchat.cloud')).toBe(false)
		expect(isAllowedHost('cdn.vrchat.cloud')).toBe(true)
	})

	test('only the API host is trusted with the session cookie', () => {
		// The CDN hosts are fetched without it. Sending a session cookie to a
		// third party is the failure this separation exists to prevent.
		expect(isApiHost('api.vrchat.cloud')).toBe(true)

		for (const host of ['assets.vrchat.com', 'cdn.vrchat.cloud', 'd348imysud55la.cloudfront.net']) {
			expect(isApiHost(host)).toBe(false)
		}
	})
})
