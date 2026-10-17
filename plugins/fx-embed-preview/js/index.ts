import { Dispatcher } from '@revenge-mod/discord/common/flux'
import { onFluxEventDispatched, Stores } from '@revenge-mod/discord/flux'
import {
	buildEmbeds,
	fetchPreview,
	isOurEmbed,
	parseLink,
	parseLinks,
} from './preview'
import type { PreviewData, PreviewLink, Provider } from './preview'

const MaxPreviewsPerMessage = 3
const MaxConcurrentRequests = 3
const MaxQueuedRequests = 64
const MaxCachedPreviews = 256
const RequestTimeoutMs = 12_000
const SuccessCacheMs = 30 * 60_000
const FailureCacheMs = 30_000
const SuppressEmbedsFlag = 1 << 2

interface Embed {
	id?: string
	url?: string
	[key: string]: unknown
}

interface Message {
	id?: string
	channel_id?: string
	guild_id?: string
	content?: unknown
	flags?: number
	embeds?: Embed[]
}

interface MessageRef {
	channelId: string
	messageId: string
}

interface MessageStoreApi {
	getMessage(channelId: string, messageId: string): Message | undefined
	getMessages?(channelId: string): {
		toArray?(): Message[]
		_array?: Message[]
	}
}

interface SelectedChannelStoreApi {
	getChannelId?(): string | undefined
}

interface CacheEntry {
	status: 'loading' | 'ready' | 'failed'
	expiresAt: number
	data?: PreviewData
}

interface DispatchEvent {
	type: string
	[key: string]: unknown
}

const providers = new Set<Provider>([
	'x',
	'reddit',
	'tiktok',
	'instagram',
	'youtube',
	'bluesky',
])
const cache = new Map<string, CacheEntry>()
const rawEmbeds = new Map<string, Embed[]>()
const injectedMessages = new Set<string>()
const waitingMessages = new Map<string, Map<string, MessageRef>>()
const requestQueue: PreviewLink[] = []
const controllers = new Set<AbortController>()
const providerConfig = {
	tiktokDomain: 'tnktok.com',
	instagramDomain: 'eeinstagram.com',
}

let activeRequests = 0
let generation = 0
let stopped = false
let reportError: (message: string) => void = console.error
const reportedStoreErrors = new Set<string>()

export default plugin({
	start({ cleanup, plugin }) {
		stopped = false
		reportError = message => plugin.reportError(message)

		const handle = (event: DispatchEvent) => {
			try {
				handleDispatch(event)
			} catch (error) {
				reportError(`Failed to process message event: ${errorMessage(error)}`)
			}
			return event
		}

		const unsubscribe: Array<() => void> = []
		try {
			unsubscribe.push(onFluxEventDispatched('MESSAGE_CREATE', handle))
			unsubscribe.push(onFluxEventDispatched('MESSAGE_UPDATE', handle))
			unsubscribe.push(onFluxEventDispatched('LOAD_MESSAGES_SUCCESS', handle))
		} catch (error) {
			for (const stop of unsubscribe) stop()
			stopped = true
			reportError(
				`Fx Embed Preview could not register message listeners: ${errorMessage(error)}`,
			)
			return
		}
		cleanup(...unsubscribe)
		setTimeout(refreshVisibleMessages, 0)

		cleanup(() => {
			stopped = true
			generation++
			requestQueue.length = 0
			for (const controller of controllers) controller.abort()
			controllers.clear()
			for (const key of injectedMessages) {
				const ref = splitMessageKey(key)
				const message = getMessageStore()?.getMessage(
					ref.channelId,
					ref.messageId,
				)
				if (message && !((message.flags ?? 0) & SuppressEmbedsFlag))
					dispatchEmbeds(ref, rawEmbeds.get(key) ?? [])
			}
			injectedMessages.clear()
			rawEmbeds.clear()
			waitingMessages.clear()
			cache.clear()
			activeRequests = 0
			reportError = console.error
		})
	},
})

function handleDispatch(event: DispatchEvent | undefined) {
	if (stopped || !event || event.__fxp) return

	switch (event.type) {
		case 'MESSAGE_CREATE':
			processRawMessage(event.message as Message | undefined, false)
			break
		case 'MESSAGE_UPDATE':
			processRawMessage(event.message as Message | undefined, true)
			break
		case 'LOAD_MESSAGES_SUCCESS':
			if (Array.isArray(event.messages)) {
				for (const message of event.messages)
					processRawMessage(message as Message, false)
			}
			break
	}
}

function processRawMessage(message: Message | undefined, partial: boolean) {
	if (!message?.id || !message.channel_id) return

	const ref = { channelId: message.channel_id, messageId: message.id }
	const key = messageKey(ref)
	const embeds = message.embeds
	if (Array.isArray(embeds)) {
		const originals = embeds.filter(embed => !isOurEmbed(embed))
		if (originals.length || embeds.length === 0 || !rawEmbeds.has(key)) {
			rawEmbeds.set(key, originals)
			trim(rawEmbeds, MaxCachedPreviews)
		}
		if (originals.length !== embeds.length) {
			message.embeds = originals
			injectedMessages.delete(key)
		}
	} else if (!partial && !rawEmbeds.has(key)) {
		rawEmbeds.set(key, [])
		trim(rawEmbeds, MaxCachedPreviews)
	}

	if ((message.flags ?? 0) & SuppressEmbedsFlag) {
		injectedMessages.delete(key)
		return
	}

	const storedMessage = getMessageStore()?.getMessage(
		ref.channelId,
		ref.messageId,
	)
	const content =
		typeof message.content === 'string'
			? message.content
			: storedMessage?.content
	const links = parseLinks(content, providers, MaxPreviewsPerMessage)
	if (!links.length) {
		if (injectedMessages.delete(key)) message.embeds = rawEmbeds.get(key) ?? []
		return
	}

	for (const link of links) trackMessage(link, ref)
	const ready = links.some(link => getCacheEntry(link.key)?.status === 'ready')
	if (ready && Array.isArray(message.embeds))
		applyReadyEmbeds(message, ref, links)

	setTimeout(() => refreshMessage(ref), 0)
}

function trackMessage(link: PreviewLink, ref: MessageRef) {
	const entry = getCacheEntry(link.key)
	if (entry?.status === 'ready' || entry?.status === 'failed') return

	let waiting = waitingMessages.get(link.key)
	if (!waiting) {
		waiting = new Map()
		waitingMessages.set(link.key, waiting)
	}
	waiting.set(messageKey(ref), ref)

	if (entry) return
	if (requestQueue.length >= MaxQueuedRequests) {
		cache.set(link.key, {
			status: 'failed',
			expiresAt: Date.now() + FailureCacheMs,
		})
		waitingMessages.delete(link.key)
		return
	}

	cache.set(link.key, {
		status: 'loading',
		expiresAt: Number.POSITIVE_INFINITY,
	})
	requestQueue.push(link)
	pumpQueue()
}

function pumpQueue() {
	while (
		!stopped &&
		activeRequests < MaxConcurrentRequests &&
		requestQueue.length
	) {
		const link = requestQueue.shift()!
		const requestGeneration = generation
		const controller = new AbortController()
		const timeout = setTimeout(() => controller.abort(), RequestTimeoutMs)
		controllers.add(controller)
		activeRequests++

		void fetchPreview(link, providerConfig, controller.signal)
			.then(data => {
				if (stopped || generation !== requestGeneration) return
				cache.set(link.key, {
					status: 'ready',
					expiresAt: Date.now() + SuccessCacheMs,
					data,
				})
				trim(cache, MaxCachedPreviews)
				refreshWaitingMessages(link.key)
			})
			.catch(() => {
				if (stopped || generation !== requestGeneration) return
				cache.set(link.key, {
					status: 'failed',
					expiresAt: Date.now() + FailureCacheMs,
				})
				trim(cache, MaxCachedPreviews)
				waitingMessages.delete(link.key)
			})
			.finally(() => {
				clearTimeout(timeout)
				controllers.delete(controller)
				if (stopped || generation !== requestGeneration) return
				activeRequests--
				pumpQueue()
			})
	}
}

function getCacheEntry(key: string) {
	const entry = cache.get(key)
	if (entry && entry.status !== 'loading' && entry.expiresAt <= Date.now()) {
		cache.delete(key)
		return
	}
	return entry
}

function refreshWaitingMessages(linkKey: string) {
	const waiting = waitingMessages.get(linkKey)
	if (!waiting) return
	waitingMessages.delete(linkKey)
	for (const ref of waiting.values()) refreshMessage(ref)
}

function refreshMessage(ref: MessageRef) {
	if (stopped) return
	const message = getMessageStore()?.getMessage(ref.channelId, ref.messageId)
	if (!message || (message.flags ?? 0) & SuppressEmbedsFlag) return

	const links = parseLinks(message.content, providers, MaxPreviewsPerMessage)
	if (!links.length) return
	for (const link of links) trackMessage(link, ref)
	applyReadyEmbeds(message, ref, links)
}

function applyReadyEmbeds(
	message: Message,
	ref: MessageRef,
	links: PreviewLink[],
) {
	const key = messageKey(ref)
	const originals =
		rawEmbeds.get(key) ??
		(Array.isArray(message.embeds)
			? message.embeds.filter(embed => !isOurEmbed(embed))
			: [])
	const { embeds, changed } = composeEmbeds(originals, links)
	if (!changed) return

	if (message === getMessageStore()?.getMessage(ref.channelId, ref.messageId)) {
		dispatchEmbeds(ref, embeds)
	} else {
		message.embeds = embeds
		injectedMessages.add(key)
	}
}

function composeEmbeds(originals: Embed[], links: PreviewLink[]) {
	const ready = links.flatMap(link => {
		const entry = getCacheEntry(link.key)
		return entry?.status === 'ready' && entry.data
			? [{ link, data: entry.data }]
			: []
	})
	if (!ready.length) return { embeds: originals, changed: false }

	const hasProvider = (provider: Provider) =>
		links.some(link => link.provider === provider)
	const kept = originals.filter(embed => {
		if (isOurEmbed(embed)) return false
		const link =
			typeof embed.url === 'string' ? parseLink(embed.url) : undefined
		if (link && ready.some(item => item.link.key === link.key)) return false
		if (!link) {
			const host = embed.url ? safeHostname(embed.url) : ''
			const matchesProvider =
				(host === 'x.com' ||
					host.endsWith('.x.com') ||
					host === 'twitter.com' ||
					host.endsWith('.twitter.com') ||
					host === 'fxtwitter.com' ||
					host.endsWith('.fxtwitter.com') ||
					host === 'vxtwitter.com' ||
					host.endsWith('.vxtwitter.com') ||
					host === 'fixupx.com' ||
					host.endsWith('.fixupx.com')) &&
				hasProvider('x')
					? 'x'
					: host === 'reddit.com' ||
							host.endsWith('.reddit.com') ||
							host === 'redd.it' ||
							host.endsWith('.redd.it')
						? 'reddit'
						: host === 'tiktok.com' ||
								host.endsWith('.tiktok.com') ||
								host === 'tnktok.com' ||
								host.endsWith('.tnktok.com')
							? 'tiktok'
							: [
										'instagram.com',
										'ddinstagram.com',
										'eeinstagram.com',
										'kkinstagram.com',
										'uuinstagram.com',
										'vxinstagram.com',
										'fxstagram.com',
										'instagramez.com',
									].some(
										domain => host === domain || host.endsWith(`.${domain}`),
									)
								? 'instagram'
								: host === 'youtube.com' ||
										host.endsWith('.youtube.com') ||
										host === 'youtu.be'
									? 'youtube'
									: host === 'bsky.app'
										? 'bluesky'
										: undefined
			if (
				matchesProvider &&
				links.filter(item => item.provider === matchesProvider).length === 1 &&
				ready.some(item => item.link.provider === matchesProvider)
			)
				return false
		}
		return true
	})

	const embeds = [...kept, ...ready.flatMap(item => buildEmbeds(item.data))]
	return {
		embeds,
		changed:
			JSON.stringify(embeds) !==
			JSON.stringify([...originals.filter(embed => !isOurEmbed(embed))]),
	}
}

function dispatchEmbeds(ref: MessageRef, embeds: Embed[]) {
	const message = getMessageStore()?.getMessage(ref.channelId, ref.messageId)
	if (!message) return
	const event = {
		type: 'MESSAGE_UPDATE',
		__fxp: true,
		message: {
			id: ref.messageId,
			channel_id: ref.channelId,
			guild_id: message.guild_id,
			flags: message.flags,
			embeds,
		},
	}
	try {
		void Dispatcher.dispatch(event).catch(error => {
			reportError(`Failed to refresh message preview: ${errorMessage(error)}`)
			message.embeds = embeds
		})
	} catch (error) {
		reportError(`Failed to dispatch message preview: ${errorMessage(error)}`)
		message.embeds = embeds
	}
	const key = messageKey(ref)
	if (embeds.some(isOurEmbed)) injectedMessages.add(key)
	else injectedMessages.delete(key)
	trim(injectedMessages, MaxCachedPreviews)
}

function refreshVisibleMessages() {
	const channelId = getSelectedChannelStore()?.getChannelId?.()
	if (!channelId) return
	const collection = getMessageStore()?.getMessages?.(channelId)
	const messages = collection?.toArray?.() ?? collection?._array ?? []
	for (const message of messages) {
		if (!message.id) continue
		const ref = {
			channelId: message.channel_id ?? channelId,
			messageId: message.id,
		}
		const links = parseLinks(message.content, providers, MaxPreviewsPerMessage)
		for (const link of links) trackMessage(link, ref)
		refreshMessage(ref)
	}
}

function getMessageStore() {
	try {
		return Stores.MessageStore as unknown as MessageStoreApi
	} catch (error) {
		reportStoreError('message', error)
	}
}

function getSelectedChannelStore() {
	try {
		return Stores.SelectedChannelStore as unknown as SelectedChannelStoreApi
	} catch (error) {
		reportStoreError('selected-channel', error)
	}
}

function reportStoreError(store: string, error: unknown) {
	if (reportedStoreErrors.has(store)) return
	reportedStoreErrors.add(store)
	reportError(
		`Fx Embed Preview could not access the ${store} store: ${errorMessage(error)}`,
	)
}

function messageKey({ channelId, messageId }: MessageRef) {
	return `${channelId}:${messageId}`
}

function splitMessageKey(key: string): MessageRef {
	const separator = key.indexOf(':')
	return {
		channelId: key.slice(0, separator),
		messageId: key.slice(separator + 1),
	}
}

function safeHostname(value: string) {
	try {
		return new URL(value).hostname.toLowerCase().replace(/^www\./, '')
	} catch {
		return ''
	}
}

function errorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error)
}

function trim<K, V>(map: Map<K, V> | Set<K>, max: number) {
	while (map.size > max) {
		const oldest = map.keys().next().value
		if (oldest === undefined) break
		map.delete(oldest)
	}
}
