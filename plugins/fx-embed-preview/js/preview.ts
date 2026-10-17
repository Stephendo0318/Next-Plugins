export type Provider =
	| 'x'
	| 'reddit'
	| 'tiktok'
	| 'instagram'
	| 'youtube'
	| 'bluesky'

export interface PreviewLink {
	provider: Provider
	key: string
	url: string
	id?: string
	username?: string
}

export interface PreviewMedia {
	url: string
	thumbnail?: string
	width?: number
	height?: number
	type?: 'video' | 'gif'
}

export interface PreviewData {
	provider: Provider
	url: string
	title?: string
	description?: string
	author?: string
	authorUrl?: string
	image?: string
	videos: PreviewMedia[]
	photos: PreviewMedia[]
}

export interface ProviderConfig {
	tiktokDomain: string
	instagramDomain: string
}

interface HttpResponse {
	status: number
	text: string
	url: string
}

const BrowserAgent =
	'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36'
const DiscordAgent = 'Mozilla/5.0 (compatible; Discordbot/2.0)'

export function parseLinks(
	content: unknown,
	providers: ReadonlySet<Provider>,
	max = 3,
): PreviewLink[] {
	if (typeof content !== 'string' || !content) return []

	const found = new Map<string, { index: number; link: PreviewLink }>()
	const urlPattern = /<?https?:\/\/[^\s<>{}[\]"'`]+/gi
	for (const match of content.matchAll(urlPattern)) {
		if (match[0].startsWith('<')) continue
		const candidate = match[0].replace(/[),.!?;:]+$/g, '')
		const link = parseLink(candidate)
		if (!link || !providers.has(link.provider)) continue
		if (!found.has(link.key)) found.set(link.key, { index: match.index, link })
	}

	return [...found.values()]
		.sort((left, right) => left.index - right.index)
		.slice(0, max)
		.map(item => item.link)
}

export function parseLink(rawUrl: string): PreviewLink | undefined {
	try {
		const parsed = new URL(rawUrl)
		if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return
		const host = parsed.hostname.toLowerCase().replace(/^www\./, '')
		const on = (domain: string) =>
			host === domain || host.endsWith(`.${domain}`)
		const cleanUrl = parsed
			.toString()
			.replace(/[?#].*$/, '')
			.replace(/\/+$/, '')

		if (on('x.com') || on('twitter.com')) {
			const match = parsed.pathname.match(
				/^\/(?:([A-Za-z0-9_]{1,30})\/)?(?:i\/)?(?:web\/)?status(?:es)?\/(\d+)/i,
			)
			if (!match) return
			const username = match[1] ?? 'i'
			return {
				provider: 'x',
				key: `x:${match[2]}`,
				url: `https://x.com/${username}/status/${match[2]}`,
				username,
				id: match[2],
			}
		}

		if (
			(on('reddit.com') &&
				/\/(?:r\/[a-z0-9_]+\/)?(?:comments|s)\/[a-z0-9]+/i.test(
					parsed.pathname,
				)) ||
			on('redd.it')
		)
			return { provider: 'reddit', key: `reddit:${cleanUrl}`, url: cleanUrl }

		if (
			(on('tiktok.com') &&
				(/\/@[a-z0-9_.]+\/(?:video|photo)\/\d+/i.test(parsed.pathname) ||
					/\/t\/[a-z0-9]+/i.test(parsed.pathname))) ||
			on('vm.tiktok.com') ||
			on('vt.tiktok.com')
		)
			return { provider: 'tiktok', key: `tiktok:${cleanUrl}`, url: cleanUrl }

		if (
			on('instagram.com') &&
			/^\/(?:(?:[a-z0-9_.]+)\/)?(?:p|reel|reels|tv|share)\/[a-z0-9_-]+/i.test(
				parsed.pathname,
			)
		)
			return {
				provider: 'instagram',
				key: `instagram:${cleanUrl}`,
				url: cleanUrl,
			}

		if (
			(on('youtube.com') &&
				/^\/(?:watch|shorts|live|embed)\b/i.test(parsed.pathname)) ||
			on('youtu.be')
		) {
			const url =
				on('youtube.com') && parsed.pathname === '/watch'
					? `https://www.youtube.com/watch?v=${encodeURIComponent(parsed.searchParams.get('v') ?? '')}`
					: cleanUrl
			return { provider: 'youtube', key: `youtube:${url}`, url }
		}

		if (
			on('bsky.app') &&
			/^\/profile\/[^/]+\/post\/[^/]+/i.test(parsed.pathname)
		)
			return {
				provider: 'bluesky',
				key: `bluesky:${cleanUrl}`,
				url: cleanUrl,
			}
	} catch {
		return
	}
}

export function buildEmbeds(post: PreviewData): Record<string, unknown>[] {
	const markerFooter = { text: 'FxEmbed Preview' }
	const description = post.description?.slice(0, 4000)
	const author = post.author
		? { name: post.author, ...(post.authorUrl ? { url: post.authorUrl } : {}) }
		: undefined
	const media = [
		...post.videos.map(item => ({
			item,
			kind: item.type === 'gif' ? 'gifv' : 'video',
		})),
		...post.photos.map(item => ({ item, kind: 'photo' })),
	].slice(0, 4)

	const header: Record<string, unknown> = {
		url: post.url,
		type: 'rich',
		...(post.title ? { title: post.title.slice(0, 256) } : {}),
		...(description ? { description } : {}),
		...(author ? { author } : {}),
		provider: { name: 'FxEmbed Preview' },
		footer: markerFooter,
	}

	if (!media.length) return [header]

	return media.map(({ item, kind }, index) => ({
		...(index === 0
			? header
			: {
					url: post.url,
					provider: { name: 'FxEmbed Preview' },
					footer: markerFooter,
				}),
		...(kind === 'photo'
			? { image: mediaObject(item.url, item.width, item.height) }
			: {
					video: mediaObject(item.url, item.width, item.height),
					...(item.thumbnail ? { thumbnail: mediaObject(item.thumbnail) } : {}),
				}),
		type: kind,
	}))
}

export function isOurEmbed(embed: Record<string, unknown>) {
	const footer = embed.footer as { text?: unknown } | undefined
	const provider = embed.provider as { name?: unknown } | undefined
	return (
		(typeof embed.id === 'string' &&
			embed.id.startsWith('com.revenge.fx-embed-preview:')) ||
		(typeof footer?.text === 'string' &&
			footer.text.startsWith('FxEmbed Preview')) ||
		provider?.name === 'FxEmbed Preview'
	)
}

export function isPlayableMediaUrl(value?: string): value is string {
	if (!value) return false
	try {
		const url = new URL(value)
		return (
			url.protocol === 'https:' &&
			/\.(?:mp4|m3u8|webm)(?:$|[?#])/i.test(url.pathname + url.search)
		)
	} catch {
		return false
	}
}

export async function fetchPreview(
	link: PreviewLink,
	config: ProviderConfig,
	signal: AbortSignal,
): Promise<PreviewData> {
	switch (link.provider) {
		case 'x':
			return fetchX(link, signal)
		case 'reddit':
			return fetchReddit(link, signal)
		case 'tiktok':
			return fetchTikTok(link, config, signal)
		case 'instagram':
			return fetchInstagram(link, config, signal)
		case 'youtube':
			return fetchOEmbed(
				`https://www.youtube.com/oembed?url=${encodeURIComponent(link.url)}&format=json`,
				link,
				signal,
			)
		case 'bluesky':
			return fetchOEmbed(
				`https://embed.bsky.app/oembed?url=${encodeURIComponent(link.url)}&format=json`,
				link,
				signal,
			)
	}
}

function mediaObject(url: string, width?: number, height?: number) {
	return {
		url,
		proxy_url: url,
		...(width ? { width } : {}),
		...(height ? { height } : {}),
	}
}

async function request(
	url: string,
	signal: AbortSignal,
	headers: Record<string, string> = {},
): Promise<HttpResponse> {
	const response = await fetch(url, {
		signal,
		credentials: 'omit',
		headers,
	})
	return {
		status: response.status,
		text: (await response.text()).slice(0, 2_000_000),
		url: response.url || url,
	}
}

function parseJson(value: string) {
	try {
		return JSON.parse(value) as Record<string, any>
	} catch {
		return undefined
	}
}

async function fetchX(
	link: PreviewLink,
	signal: AbortSignal,
): Promise<PreviewData> {
	const id = link.id
	if (!id) throw new Error('Invalid X status URL')
	const user =
		link.username && /^[A-Za-z0-9_]{1,30}$/.test(link.username)
			? link.username
			: 'i'

	let fxJson: Record<string, any> | undefined
	let fxStatus = 0
	try {
		const fx = await request(
			`https://api.fxtwitter.com/2/status/${encodeURIComponent(id)}`,
			signal,
			{ Accept: 'application/json', 'User-Agent': 'Revenge-FxEmbedPreview' },
		)
		fxStatus = fx.status
		fxJson = parseJson(fx.text)
	} catch {
		if (signal.aborted) throw new Error('X preview request timed out')
	}
	const status = fxJson?.status
	if (
		fxStatus >= 200 &&
		fxStatus < 300 &&
		status &&
		status.type !== 'tombstone'
	) {
		const media = status.media ?? {}
		const quote = status.quote
		const tweetMedia = media.videos?.length ? media : (quote?.media ?? media)
		const videos = Array.isArray(tweetMedia?.videos)
			? tweetMedia.videos
					.filter((item: any) => isHttps(item.url))
					.map((item: any) => ({
						url: item.url as string,
						thumbnail: isHttps(item.thumbnail_url)
							? item.thumbnail_url
							: undefined,
						type: /gif/i.test(item.type ?? '')
							? ('gif' as const)
							: ('video' as const),
						width: positive(item.width),
						height: positive(item.height),
					}))
			: []
		const photos = Array.isArray(media.photos)
			? media.photos
					.filter((item: any) => isHttps(item.url))
					.map((item: any) => ({
						url: item.url as string,
						width: positive(item.width),
						height: positive(item.height),
					}))
			: []
		return {
			provider: 'x',
			url: link.url,
			title: status.text?.slice(0, 256) || 'Post on X',
			description: status.text,
			author: status.author?.name
				? `${status.author.name}${status.author.screen_name ? ` (@${status.author.screen_name})` : ''}`
				: undefined,
			authorUrl: status.author?.screen_name
				? `https://x.com/${status.author.screen_name}`
				: undefined,
			image: videos[0]?.thumbnail ?? photos[0]?.url,
			videos,
			photos: videos.length ? [] : photos,
		}
	}

	const vx = await request(
		`https://api.vxtwitter.com/${encodeURIComponent(user)}/status/${encodeURIComponent(id)}`,
		signal,
		{ Accept: 'application/json', 'User-Agent': 'Revenge-FxEmbedPreview' },
	)
	const tweet = parseJson(vx.text)?.tweet ?? parseJson(vx.text)
	if (vx.status < 200 || vx.status >= 300 || !tweet) {
		throw new Error(`X preview request failed (${vx.status || fxStatus})`)
	}
	const extended = Array.isArray(tweet.media_extended)
		? tweet.media_extended
		: []
	const videos = extended
		.filter(
			(item: any) => /video|gif/i.test(item.type ?? '') && isHttps(item.url),
		)
		.map((item: any) => ({
			url: item.url as string,
			thumbnail: isHttps(item.thumbnail_url) ? item.thumbnail_url : undefined,
			type: /gif/i.test(item.type ?? '')
				? ('gif' as const)
				: ('video' as const),
			width: positive(item.size?.width),
			height: positive(item.size?.height),
		}))
	const photos = extended
		.filter(
			(item: any) => /photo|image/i.test(item.type ?? '') && isHttps(item.url),
		)
		.map((item: any) => ({
			url: item.url as string,
			width: positive(item.size?.width),
			height: positive(item.size?.height),
		}))

	return {
		provider: 'x',
		url: link.url,
		title: tweet.text?.slice(0, 256) || 'Post on X',
		description: tweet.text,
		author: tweet.user_name
			? `${tweet.user_name}${tweet.user_screen_name ? ` (@${tweet.user_screen_name})` : ''}`
			: undefined,
		authorUrl: tweet.user_screen_name
			? `https://x.com/${tweet.user_screen_name}`
			: undefined,
		image: videos[0]?.thumbnail ?? photos[0]?.url,
		videos,
		photos: videos.length ? [] : photos,
	}
}

async function fetchReddit(
	link: PreviewLink,
	signal: AbortSignal,
): Promise<PreviewData> {
	let url = link.url
	if (/redd\.it|\/s\//i.test(url)) {
		const redirect = await request(url, signal, {
			'User-Agent': BrowserAgent,
			Accept: 'text/html',
		})
		url = redirect.url
	}
	const id = url.match(/\/comments\/([a-z0-9]+)/i)?.[1]
	if (!id) throw new Error('Could not resolve Reddit post URL')

	const response = await request(
		`https://www.reddit.com/comments/${encodeURIComponent(id)}.json?raw_json=1&limit=1`,
		signal,
		{ Accept: 'application/json', 'User-Agent': BrowserAgent },
	)
	if (response.status < 200 || response.status >= 300)
		throw new Error(`Reddit preview request failed (${response.status})`)
	const listing = parseJson(response.text)
	const post = listing?.[0]?.data?.children?.[0]?.data
	if (!post) throw new Error('Reddit preview response was empty')
	const content = post.crosspost_parent_list?.[0] ?? post
	const photos: PreviewMedia[] = []
	if (
		content.is_gallery &&
		content.gallery_data?.items &&
		content.media_metadata
	) {
		for (const item of content.gallery_data.items) {
			const source = content.media_metadata[item.media_id]?.s
			const image = decodeHtml(source?.u ?? source?.gif)
			if (isHttps(image))
				photos.push({
					url: image,
					width: positive(source?.x),
					height: positive(source?.y),
				})
		}
	}
	const previewImage = decodeHtml(content.preview?.images?.[0]?.source?.url)
	if (!photos.length && isHttps(previewImage))
		photos.push({ url: previewImage })

	const rawVideo =
		content.secure_media?.reddit_video ?? content.preview?.reddit_video_preview
	const videos: PreviewMedia[] = isHttps(rawVideo?.fallback_url)
		? [
				{
					url: rawVideo.fallback_url,
					thumbnail: isHttps(previewImage) ? previewImage : undefined,
					width: positive(rawVideo.width),
					height: positive(rawVideo.height),
					type: rawVideo.is_gif ? 'gif' : 'video',
				},
			]
		: []

	return {
		provider: 'reddit',
		url:
			typeof post.permalink === 'string'
				? `https://www.reddit.com${post.permalink}`
				: url,
		title: post.title,
		description:
			typeof post.selftext === 'string'
				? post.selftext.slice(0, 4000)
				: undefined,
		author: post.author ? `u/${post.author}` : undefined,
		authorUrl: post.author
			? `https://www.reddit.com/user/${encodeURIComponent(post.author)}`
			: undefined,
		image: videos[0]?.thumbnail ?? photos[0]?.url,
		videos,
		photos: videos.length ? [] : photos,
	}
}

async function fetchTikTok(
	link: PreviewLink,
	config: ProviderConfig,
	signal: AbortSignal,
): Promise<PreviewData> {
	const proxied = swapHost(link.url, 'tiktok.com', config.tiktokDomain)
	if (proxied !== link.url) {
		try {
			const og = await fetchOpenGraph(proxied, link, signal)
			if (og.title || og.image || og.videos.length) return og
		} catch {
			// TikTok oEmbed and page metadata are attempted below.
		}
	}

	let resolved = link.url
	if (/\/\/(?:vm|vt)\.tiktok\.com\//i.test(resolved)) {
		resolved = (
			await request(resolved, signal, {
				'User-Agent': BrowserAgent,
				Accept: 'text/html',
			})
		).url
	}
	try {
		const embed = await request(
			`https://www.tiktok.com/oembed?url=${encodeURIComponent(resolved)}`,
			signal,
			{ Accept: 'application/json', 'User-Agent': BrowserAgent },
		)
		const data = parseJson(embed.text)
		if (embed.status >= 200 && embed.status < 300 && data) {
			return {
				provider: 'tiktok',
				url: resolved,
				title: data.title ?? `TikTok video by ${data.author_name ?? 'creator'}`,
				author: data.author_name,
				authorUrl: data.author_url,
				image: isHttps(data.thumbnail_url) ? data.thumbnail_url : undefined,
				videos: [],
				photos: [],
			}
		}
	} catch {
		// The page's Open Graph metadata is the last public fallback.
	}
	return fetchOpenGraph(resolved, link, signal)
}

async function fetchInstagram(
	link: PreviewLink,
	config: ProviderConfig,
	signal: AbortSignal,
): Promise<PreviewData> {
	const proxied = swapHost(link.url, 'instagram.com', config.instagramDomain)
	if (proxied !== link.url) {
		try {
			const og = await fetchOpenGraph(proxied, link, signal)
			if (og.title || og.image || og.videos.length) return og
		} catch {
			// Try the public Instagram page below.
		}
	}
	return fetchOpenGraph(link.url, link, signal)
}

async function fetchOEmbed(
	endpoint: string,
	link: PreviewLink,
	signal: AbortSignal,
): Promise<PreviewData> {
	const response = await request(endpoint, signal, {
		Accept: 'application/json',
		'User-Agent': BrowserAgent,
	})
	if (response.status < 200 || response.status >= 300)
		throw new Error(
			`${link.provider} preview request failed (${response.status})`,
		)
	const data = parseJson(response.text)
	if (!data?.title)
		throw new Error(`${link.provider} returned no preview title`)
	return {
		provider: link.provider,
		url: link.url,
		title: data.title,
		author: data.author_name,
		image: isHttps(data.thumbnail_url) ? data.thumbnail_url : undefined,
		videos: [],
		photos: [],
	}
}

async function fetchOpenGraph(
	url: string,
	link: PreviewLink,
	signal: AbortSignal,
): Promise<PreviewData> {
	const response = await request(url, signal, {
		Accept: 'text/html,application/xhtml+xml',
		'User-Agent': DiscordAgent,
	})
	if (response.status < 200 || response.status >= 300)
		throw new Error(
			`${link.provider} preview request failed (${response.status})`,
		)

	const tags = readMetaTags(response.text)
	const title =
		tags['og:title'] ??
		tags['twitter:title'] ??
		response.text.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]
	const description =
		tags['og:description'] ?? tags['twitter:description'] ?? tags.description
	const image = absoluteUrl(
		tags['og:image:secure_url'] ?? tags['og:image'] ?? tags['twitter:image'],
		response.url,
	)
	const videoType = tags['og:video:type'] ?? ''
	const videoUrl = /html/i.test(videoType)
		? undefined
		: absoluteUrl(
				tags['og:video:secure_url'] ??
					tags['og:video:url'] ??
					tags['og:video'] ??
					tags['twitter:player:stream'],
				response.url,
			)
	const videos: PreviewMedia[] = isPlayableMediaUrl(videoUrl)
		? [{ url: videoUrl, thumbnail: image, type: 'video' }]
		: []
	if (!title && !description && !image && !videos.length)
		throw new Error(
			`${link.provider} page did not include public preview metadata`,
		)
	return {
		provider: link.provider,
		url: link.url,
		title: title ? decodeHtml(title).slice(0, 256) : undefined,
		description: description
			? decodeHtml(description).slice(0, 4000)
			: undefined,
		image,
		videos,
		photos: !videos.length && image ? [{ url: image }] : [],
	}
}

function readMetaTags(html: string) {
	const tags: Record<string, string> = {}
	for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
		const tag = match[0]
		const key = readAttribute(tag, 'property') ?? readAttribute(tag, 'name')
		const value = readAttribute(tag, 'content')
		if (key && value && !(key.toLowerCase() in tags))
			tags[key.toLowerCase()] = decodeHtml(value)
	}
	return tags
}

function readAttribute(tag: string, name: string) {
	const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
	return tag
		.match(
			new RegExp(
				`\\b${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
				'i',
			),
		)
		?.slice(1)
		.find(Boolean)
}

function decodeHtml(value: string) {
	return value
		.replace(/&amp;/gi, '&')
		.replace(/&quot;/gi, '"')
		.replace(/&#39;|&apos;/gi, "'")
		.replace(/&lt;/gi, '<')
		.replace(/&gt;/gi, '>')
		.replace(/&nbsp;/gi, ' ')
		.replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
			String.fromCodePoint(Number.parseInt(hex, 16)),
		)
		.replace(/&#(\d+);/g, (_, decimal: string) =>
			String.fromCodePoint(Number.parseInt(decimal, 10)),
		)
}

function absoluteUrl(value: string | undefined, base: string) {
	if (!value) return
	try {
		const url = new URL(value, base)
		return url.protocol === 'https:' ? url.toString() : undefined
	} catch {
		return
	}
}

function isHttps(value: unknown): value is string {
	if (typeof value !== 'string') return false
	try {
		return new URL(value).protocol === 'https:'
	} catch {
		return false
	}
}

function positive(value: unknown) {
	return typeof value === 'number' && Number.isFinite(value) && value > 0
		? value
		: undefined
}

function swapHost(url: string, original: string, replacement: string) {
	const domain = replacement
		.trim()
		.toLowerCase()
		.replace(/^https?:\/\//, '')
		.replace(/\/.*$/, '')
	if (!domain) return url

	try {
		const parsed = new URL(url)
		const sourceHost = parsed.hostname.toLowerCase()
		if (sourceHost !== original && !sourceHost.endsWith(`.${original}`))
			return url
		const prefix = sourceHost
			.slice(0, -(original.length + (sourceHost === original ? 0 : 1)))
			.replace(/^(?:www|m|mobile)\./, '')
		parsed.hostname = `${prefix ? `${prefix}.` : ''}${domain}`
		return parsed.toString()
	} catch {
		return url
	}
}
