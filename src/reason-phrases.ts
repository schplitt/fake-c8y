// The standard HTTP reason phrases (RFC 9110 and the IANA registry, as Node's
// http.STATUS_CODES has them). The platform answers over HTTP/1.1, so a
// client sees the reason phrase in `statusText`; a Response built with only a
// status has an empty one.
const REASON_PHRASES: Readonly<Record<number, string>> = {
  100: 'Continue',
  101: 'Switching Protocols',
  102: 'Processing',
  103: 'Early Hints',
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  203: 'Non-Authoritative Information',
  204: 'No Content',
  205: 'Reset Content',
  206: 'Partial Content',
  207: 'Multi-Status',
  208: 'Already Reported',
  226: 'IM Used',
  300: 'Multiple Choices',
  301: 'Moved Permanently',
  302: 'Found',
  303: 'See Other',
  304: 'Not Modified',
  305: 'Use Proxy',
  307: 'Temporary Redirect',
  308: 'Permanent Redirect',
  400: 'Bad Request',
  401: 'Unauthorized',
  402: 'Payment Required',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  406: 'Not Acceptable',
  407: 'Proxy Authentication Required',
  408: 'Request Timeout',
  409: 'Conflict',
  410: 'Gone',
  411: 'Length Required',
  412: 'Precondition Failed',
  413: 'Payload Too Large',
  414: 'URI Too Long',
  415: 'Unsupported Media Type',
  416: 'Range Not Satisfiable',
  417: 'Expectation Failed',
  418: 'I\'m a Teapot',
  421: 'Misdirected Request',
  422: 'Unprocessable Entity',
  423: 'Locked',
  424: 'Failed Dependency',
  425: 'Too Early',
  426: 'Upgrade Required',
  428: 'Precondition Required',
  429: 'Too Many Requests',
  431: 'Request Header Fields Too Large',
  451: 'Unavailable For Legal Reasons',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
  505: 'HTTP Version Not Supported',
  506: 'Variant Also Negotiates',
  507: 'Insufficient Storage',
  508: 'Loop Detected',
  509: 'Bandwidth Limit Exceeded',
  510: 'Not Extended',
  511: 'Network Authentication Required',
}

// Statuses whose response cannot have a body.
const NULL_BODY = new Set([101, 103, 204, 205, 304])

/**
 * The response with the standard reason phrase of its status as `statusText`,
 * unless it has one already. Where streams exist, the body streams through
 * as it arrives, so a long-lived stream reaches the caller at once. iso4 has
 * no streams (`body` is always null there, and a response built from another's
 * `body` is empty), so the body is copied there.
 * @param response - A response
 */
export async function withReasonPhrase(response: Response): Promise<Response> {
  const phrase = REASON_PHRASES[response.status]
  if (response.statusText || phrase === undefined) {
    return response
  }
  const init = { status: response.status, statusText: phrase, headers: response.headers }
  if (NULL_BODY.has(response.status)) {
    return new Response(null, init)
  }
  if (typeof TransformStream === 'undefined') {
    return new Response(await response.arrayBuffer(), init)
  }
  return new Response(response.body?.pipeThrough(new TransformStream()) ?? null, init)
}
