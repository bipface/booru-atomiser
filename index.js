/* -------------------------------------------------------------------------- */

'use strict';

const assert = require(`assert`).strict;
const crypto = require(`crypto`);
const https = require(`https`);
const stream = require('stream');
const util = require(`util`);
const {URL} = require(`url`);
const {URLSearchParams} = require(`url`);
const zlib = require(`zlib`);

const StreamArray = require('stream-json/streamers/StreamArray');

/* -------------------------------------------------------------------------- */

/* aws lambda request handler (requires lambda-proxy integration): */
exports.handleLambdaProxyRequest = async function({
	httpMethod,
	headers : requHeaders,
	path : requPath,
	pathParameters,
	queryStringParameters})
{
	requHeaders = requHeaders || {};
	pathParameters = pathParameters || {};
	queryStringParameters = queryStringParameters || {};

	let params = new URLSearchParams;
	for (let [k, v] of Object.entries(queryStringParameters)) {
		params.set(k.toLowerCase(), v);};

	try {
		let {statusCode, headers, bodyChunks} =
			handleRequest(
				httpMethod,
				requHeaders,
				requPath,
				pathParameters.domainKey || ``,
				params);

		let body = ``;
		for await (let chunk of bodyChunks) {
			body += chunk;};

		console.log(`response generated;`,
			`status code: ${statusCode};`,
			`length: ${body.length} codeunits`);

		return {
			statusCode,
			headers,
			body,};

	} catch (err) {
		return handleException(
			httpMethod,
			requHeaders,
			err);};
};

const domainTbl = {
	gelbooru : {kind : `gelbooru`, origin : `https://gelbooru.com`,
		mediaOrigin : `https://img3.gelbooru.com`},

	r34xxx : {kind : `gelbooru`, origin : `https://rule34.xxx`,
		mediaOrigin : `https://img.rule34.xxx`},
};

class ClientError extends Error {};
class UpstreamError extends Error {};

const documentationHref =
	`https://app.swaggerhub.com/apis-docs/bipface/booru-atomiser`;
const serviceTitle = `Booru Atomiser`;
const userAgentName = function(forUa) {
	let ua = serviceTitle;
	if (forUa) {
		ua += ` (on behalf of: ${forUa})`;};
	return ua;
};

const baseHeaders = Object.freeze({
	[`server`] : serviceTitle,
	[`cache-control`] : `no-store`,});

const handleRequest = function(
	method,
	requHeaders,
	requPath,
	domainKey,
	params)
{
	assert(typeof method === `string`);
	assert(typeof requHeaders === `object` && requHeaders !== null);
	assert(typeof requPath === `string`);
	assert(typeof domainKey === `string`);
	assert(params instanceof URLSearchParams);

	let requHeaderTbl = new Map();
	for (let [k, v] of Object.entries(requHeaders)) {
		requHeaderTbl.set(k.toLowerCase(), v);};

	let ua = requHeaderTbl.get(`user-agent`) || ``;
	console.log(`incoming request user-agent:`, ua);
	let respHeaders = {
		...baseHeaders,
		[`content-type`] : `application/atom+xml; charset=utf-8`,};

	let selfUrl = new URL(`https://.`);
	try {
		selfUrl.hostname = requHeaderTbl.get(`host`);
		selfUrl.pathname = requPath;
		selfUrl.search = params.toString();
	} catch (_) {};
	console.log(`incoming request href:`, selfUrl.href);

	return {
		statusCode : 200,
		headers  : respHeaders,
		bodyChunks : handleAtomRequest(
			selfUrl, method, domainKey, params, ua),};
};

const handleException = function(method, requHeaders, err) {
	console.error(err);

	assert(typeof method === `string`);
	assert(typeof requHeaders === `object` && requHeaders !== null);
	assert(err instanceof Error);

	let resp = {
		statusCode : 500,
		headers : {
			...baseHeaders,
			[`content-type`] : `text/plain; charset=utf-8`,},
		body : err.message,};

	if (err instanceof ClientError) {
		resp.statusCode = 400;
	} else if (err instanceof UpstreamError) {
		resp.statusCode = 502;};

	return resp;
};

const handleAtomRequest = function(
	selfUrl, method, targetDomainKey, params, requestorUserAgent)
{
	/* returns an async sequence of xml chunks */

	assert(selfUrl instanceof URL);
	assert(typeof method === `string`);
	assert(typeof targetDomainKey === `string`);
	assert(typeof requestorUserAgent === `string`);
	assert(params instanceof URLSearchParams);

	if (![`GET`, `HEAD`].includes(method)) {
		throw new ClientError(`unsupported method "${method}"`);};

	let domain = domainTbl[targetDomainKey];
	if (domain === undefined) {
		throw new ClientError(`unrecognised domain "${targetDomainKey}"`);};

	return getAtomXmlFromPostInfos(selfUrl, domain, params,
		getPostInfos(domain, method, params, requestorUserAgent));
};

const getAtomXmlFromPostInfos = function(selfUrl, domain, params, postInfos) {
	return {
		init : async function() {
			this.greatestUpdateTime = new Date(0);
			this.xs = postInfos[Symbol.asyncIterator]();
		},

		next : async function() {
			if (this.done) {
				return {done : true};};

			if (!this.xs) {
				await this.init();
				return {value : atomXmlHeader};};

			let {value, done} = await this.xs.next();

			if (done) {
				this.done = true;
				return {value :
					getAtomXmlFooter(
						selfUrl, domain, params, this.greatestUpdateTime)};
			};

			if (value.updated > this.greatestUpdateTime) {
				this.greatestUpdateTime = value.updated;};

			return {value : getAtomXmlEntry(domain, params, value)};
		},

		[Symbol.asyncIterator]() {return this;},
	};
};

const xmlEsc = function(chars) {
	let s = ``;
	for (let c of chars) {
		switch (c) {
			case `"` : s += `&quot;`; break;
			case `'` : s += `&apos;`; break;
			case `<` : s += `&lt;`; break;
			case `>` : s += `&gt;`; break;
			case `&` : s += `&amp;`; break;
			default : s += c; break;
		};
	};
	return s;
};

const atomXmlHeader = `<?xml version='1.0' encoding='utf-8'?>
	<feed xmlns='http://www.w3.org/2005/Atom'>
		<generator uri='${xmlEsc(documentationHref)}' version='1.0'>
			${xmlEsc(serviceTitle)}
		</generator>\n`;

const getAtomXmlEntry = function(domain, params, postInfo) {
	assert(typeof domain === `object` && domain !== null);
	assert(typeof postInfo === `object`);

	if (postInfo === null) {
		throw new Error(`failed to generate atom entry - postInfo is null`);};

	if (!((postInfo.mediaUrl) instanceof URL)) {
		throw new Error(`failed to generate atom entry - malformed mediaUrl`);};

	return `<entry>
		<title>Post #${postInfo.postId}</title>
		<id>${xmlEsc(md5Uri(postInfo.md5))}</id>
		${tryCreateTimestampElementXml(`published`, postInfo.created)}
		${tryCreateTimestampElementXml(`updated`, postInfo.updated)}
		<!--author>(artist name)</author-->

		<link rel='alternate'
			href='${xmlEsc(postPageUrl(domain, postInfo.postId).href)}'/>

		<!--link rel='related' href='(source link(s))'/-->

		<link rel='enclosure' href='${xmlEsc(postInfo.mediaUrl.href)}'/>

		${getAtomXmlEntryContent(domain, params, postInfo)}

	</entry>\n`;
};

const getAtomXmlEntryContent = function(domain, params, postInfo) {
	let mediaHref = postInfo.mediaUrl.href;

	let mode = params.get(`content`) || ``;
	switch (mode) {
		case ``:
		case `thumbnail-link` :
			return `<content type='xhtml'>
				<div xmlns='http://www.w3.org/1999/xhtml'>
					<a href='${xmlEsc(mediaHref)}' rel='noreferrer'
						referrerpolicy='no-referrer'>
						<img src='${xmlEsc(postInfo.thumbnailUrl.href)}'
							referrerpolicy='no-referrer'></img>
					</a>
				</div>
			</content>`;

		case `text-link` :
			return `<content type='text'>${xmlEsc(mediaHref)}</content>`;

		case `bare-link` :
			return `<content src='${xmlEsc(mediaHref)}'/>`;

		default :
			throw new ClientError(`unrecognised content mode "${mode}"`);
	};

	assert(false);
};

const getAtomXmlFooter = function(selfUrl, domain, params, greatestUpdateTime) {
	assert(typeof domain === `object` && domain !== null);
	assert(params instanceof URLSearchParams);
	assert(greatestUpdateTime instanceof Date);

	return `
		<title>${xmlEsc(domain.origin+` post index`)}</title>
		<subtitle>${xmlEsc(params.get(`tags`) || ``)}</subtitle>
		<id>${xmlEsc(getFeedIdUri(domain, params))}</id>
		<author><name>${xmlEsc(domain.origin)}</name></author>
		${tryCreateTimestampElementXml(`updated`, greatestUpdateTime)}

		<link rel='self' href='${xmlEsc(selfUrl.href)}'/>
		<link rel='alternate'
			href='${xmlEsc(getPostIndexPageUrl(domain, params).href)}'/>
		<link rel='via'
			href='${xmlEsc(getPostInfoApiUrl(domain, params).href)}'/>
	</feed>\n`;
};

const getFeedIdUri = function(domain, params) {
	let h = crypto.createHash(`md5`);
	h.update(domain.origin);
	h.update(params.get(`tags`) || ``);
	return md5Uri(h.digest(`hex`));
};

const tryCreateTimestampElementXml = function(tag, ts) {
	try {
		return `<${tag}>${ts.toISOString()}</${tag}>`;
	} catch (_) {
		return `<!--${tag}>(invalid date)</${tag}-->`;};
};

const getPostInfoApiUrl = function(domain, params) {
	assert(typeof domain === `object` && domain !== null);
	assert(params instanceof URLSearchParams);

	let url = new URL(domain.origin);

	switch (domain.kind) {
		case `gelbooru` :
			url.pathname = `/`
			url.searchParams.set(`page`, `dapi`);
			url.searchParams.set(`s`, `post`);
			url.searchParams.set(`q`, `index`);
			url.searchParams.set(`json`, `1`);

			if (params.get(`page`)) {
				url.searchParams.set(`pid`, params.get(`page`));};

			break;
		//case : `danbooru`; break;
		default : assert(false);
	};

	if (params.get(`limit`)) {
		let limit = tryParseInt(params.get(`limit`));
		if (limit >= 0 && limit <= 1000) {
			url.searchParams.set(`limit`, `${limit}`);
		} else {
			throw new ClientError(
				`parameter "limit" must be within range [0,1000]`);
		};
	};

	if (params.get(`tags`)) {
		url.searchParams.set(`tags`, params.get(`tags`));};

	return url;
};

const getPostIndexPageUrl = function(domain, params) {
	assert(typeof domain === `object` && domain !== null);
	assert(params instanceof URLSearchParams);

	let url = new URL(domain.origin);

	switch (domain.kind) {
		case `gelbooru` :
			url.pathname = `/index.php`
			url.searchParams.set(`page`, `post`);
			url.searchParams.set(`s`, `list`);
			break;
		//case : `danbooru`; break;
		default : assert(false);
	};

	if (params.get(`tags`)) {
		url.searchParams.set(`tags`, params.get(`tags`));};

	return url;
};

const getPostInfos = function(
	domain, method, params, requestorUserAgent)
{
	/* returns an async sequence post info objects */

	assert(typeof domain === `object` && domain !== null);
	assert(params instanceof URLSearchParams);
	assert(typeof method === `string`);
	assert(typeof requestorUserAgent === `string`);

	let url = getPostInfoApiUrl(domain, params);

	console.log(`upstream request href:`, url.href);

	return {
		init : async function() {
			let resp = await httpRequest({
				hostname : url.hostname,
				protocol : url.protocol,
				path : url.pathname+url.search,
				method : method,
				headers : {
					[`accept`] : '*/*',
					[`accept-encoding`] : acceptableHttpEncodings.join(`, `),
					[`user-agent`] : userAgentName(requestorUserAgent),},
				timeout : 10000,});

			console.log(`upstream response status:`, resp.statusCode);
			console.log(`upstream response headers:`, resp.headers);

			if (resp.statusCode !== 200) {
				throw new UpstreamError(
					`upstream api returned status `+
						`${resp.statusCode} "${resp.statusMessage}"`);
			};

			if (method === `HEAD`) {
				this.xs = {
					next : async function() {return {done : true};},
					[Symbol.asyncIterator]() {return this;},};
			} else {
				this.xs = stream.pipeline(
					resp,
					httpResponseDecoder(resp),
					StreamArray.withParser())
					[Symbol.asyncIterator]();
			};
		},

		next : async function() {
			if (!this.xs) {
				await this.init();};

			let {value, done} = await this.xs.next();
			if (done) {
				return {done};};
			return {value : postInfoFromGelbooruApiPost(domain, value.value)};
		},

		[Symbol.asyncIterator]() {return this;},
	};
};

const postInfoFromGelbooruApiPost = function(domain, post) {
	if (typeof post !== `object` || post === null) {
		return null;};

	if (!isPostId(post.id)) {
		return null;};

	let md5 = `${post.hash}`;
	if (!md5HexRegex.test(md5)) {
		return null;};

	return {
		postId : post.id,
		md5,
		created : new Date(post.created_at),
		updated : dateFromEpochSecs((post.change)|0),
		mediaUrl : gelbooruMediaUrl(
			domain.mediaOrigin, post.directory, post.image),
		thumbnailUrl : gelbooruMediaThumbnailUrl(
			domain.mediaOrigin, post.directory, post.image),};
};

const gelbooruMediaUrl = function(origin, dir, filename) {
	if ((typeof dir !== `string` && !isInt(dir))
		|| typeof filename !== `string`)
	{
		return null;};
	/* 2021-06-24 - note: r34xxx have begun providing integers
		in the .directory field; from gelbooru they're still strings */

	if (!/^(\w+)(\.\w+)$/.test(filename)) {
		return null;};

	let u = new URL(origin);
	u.pathname = `/images/${dir}/${filename}`;
	return u;
};

const gelbooruMediaThumbnailUrl = function(origin, dir, filename) {
	if ((typeof dir !== `string` && !isInt(dir))
		|| typeof filename !== `string`)
	{
		return null;};

	let match = /^(\w+)(\.\w+)$/.exec(filename);
	if (match === null || typeof (match[1]) !== `string`) {
		return null;};
	let basename = match[1];

	let u = new URL(origin);
	u.pathname = `/thumbnails/${dir}/thumbnail_${basename}.jpg`;
	return u;
};

const postPageUrl = function(domain, postId) {
	assert(isPostId(postId));

	let url = new URL(domain.origin);
	switch (domain.kind) {
		//case `danbooru` :
			//

		case `gelbooru` :
			url.pathname = `/index.php`;
			url.searchParams.set(`page`, `post`);
			url.searchParams.set(`s`, `view`);
			url.searchParams.set(`id`, `${postId}`);
			return url;

		default : assert(false);
	};

	return null;
};

const acceptableHttpEncodings = [`gzip`, `deflate`];
const httpResponseDecoder = function(httpResp) {
	let respEnc = httpResp.headers[`content-encoding`];
	switch (respEnc) {
		//case `br` :
		// (requires nodejs 11.7)
		//	return httpResp.pipe(zlib.createBrotliDecompress());
		//	break;

		case `gzip` :
		case `deflate` :
			return zlib.createUnzip();
			break;

		case `identity` :
		case undefined :
			return new stream.PassThrough;
			break;

		default :
			throw new Error(`unrecognised content-encoding "${respEnc}"`);
	};
};

const httpRequest = function(options) {
	assert(typeof options === `object`);
	return new Promise((resolve, reject) => {
		let requ = https.request(options);
		requ.on(`response`, resolve);
		requ.on(`error`, reject);
		requ.on(`timeout`, () =>
			reject(new UpstreamError(
				`upstream api request timed-out after ${requ.timeout} ms`)));
		requ.end();
	});
};

const isPostId = function(id) {
	return isInt(id) && id >= 0;
};

const tryParseInt = function(s) {
	if (typeof s !== `string`) {
		return -1;};

	let len = s.length;
	let lenNibble = len & 0b1111; /* prevent excessive iteration */
	let c0 = s.charCodeAt(0) - 48;

	let invalid =
		(lenNibble === 0)
		| (len > 10)
		| ((c0 >>> 1) > 4) /* c0 < 0 || c0 > 9 */
		| ((c0 << 3) < (lenNibble >>> 1)) /* c0 === 0 && lenNibble !== 1 */
		| (lenNibble === 10 && s > `2147483647`);

	let n = c0;
	for (let i = 1; i < lenNibble; ++i) {
		let c = s.charCodeAt(i) - 48;
		n = Math.imul(10, n) + c;
		invalid |= ((c >>> 1) > 4); /* c < 0 || c > 9 */
	};

	return n | -invalid;
};

const isInt =  function(x) {
	return (x|0) === x;
};

const dateFromEpochSecs = function(secs) {
	assert(isInt(secs));
	let d = new Date(secs * 1000);
	return d;
};

const tryParseHref = function(href, base) {
	try {
		return new URL(href, base);
	} catch (x) {
		return null;};
};

const md5HexRegex = /^[0-9a-f]{32}$/;

const md5Uri = function(md5Hex) {
	assert(typeof md5Hex === `string`);
	assert(md5HexRegex.test(md5Hex));

	let b64 = Buffer.from(md5Hex, `hex`)
		.toString(`base64`)
		.replace(/\+/g, `-`)
		.replace(/\//g, `_`)
		.replace(/\=/g, ``);

	return `ni:///md5;`+b64;
};

/* -------------------------------------------------------------------------- */

const launchTestServer = function() {
	const http = require(`http`);

	let svr = http.createServer();
	svr.on(`request`, async (requ, resp) => {
		try {
			let url = tryParseHref(requ.url, `https://.`);
			if (!url) {
				throw new ClientError(`malformed URL "${requ.url}"`);};

			let {statusCode, headers, bodyChunks} =
				handleRequest(
					requ.method, requ.headers, url.pathname,
					url.pathname.slice(1), url.searchParams);

			for (let [k, v] of Object.entries(headers)) {
				resp.setHeader(k, v);};
			resp.writeHead(statusCode);

			for await (let chunk of bodyChunks) {
				resp.write(chunk);};

		} catch (err) {
			let {statusCode, headers, body} =
				handleException(
					requ.method, requ.headers, err);

			if (!resp.headersSent) {
				for (let [k, v] of Object.entries(headers)) {
					resp.setHeader(k, v);};
				resp.writeHead(statusCode);
			};

			resp.write(body);

		} finally {
			resp.end();};
	});
	svr.listen(80, `localhost`);
};

//launchTestServer();

/* -------------------------------------------------------------------------- */

/*




































*/

/* -------------------------------------------------------------------------- */
