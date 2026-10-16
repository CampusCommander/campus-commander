const networkChange = 'ERR_NETWORK_CHANGED';

/** Read the failure text of a request. A request without a failure reads empty. */
export const requestFailureErrorText = (request) =>
  request.failure?.()?.errorText ?? '';

/** Decide whether a failed request is an installation network change. */
export const isNetworkChangeRequest = (request) =>
  requestFailureErrorText(request).includes(networkChange);

/** Decide whether a reload error is an installation network change. */
export const isNetworkChangeReloadError = (error) =>
  error?.message?.includes(`net::${networkChange}`) === true;
