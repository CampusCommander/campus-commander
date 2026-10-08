let csrf;
const status = document.querySelector('#status');
const error = document.querySelector('#error');
document.querySelector('#copy-callback').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(
      document.querySelector('#callback').textContent,
    );
    status.textContent =
      'Redirect URI copied. Paste it into the Google client configuration.';
  } catch {
    error.textContent =
      'Clipboard access failed. Select the displayed redirect URI and copy it.';
  }
});
async function post(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(csrf ? { 'x-setup-csrf': csrf } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
}
for (const [id, action] of [
  [
    'pair',
    async () => {
      const result = await post('/pair', {
        code: document.querySelector('#code').value,
      });
      document.querySelector('#code').value = '';
      csrf = result.csrf;
      document.querySelector('#callback').textContent = result.callback;
      document.querySelector('#pair').hidden = true;
      document.querySelector('#upload').hidden = false;
      document.querySelector('#file').focus();
      status.textContent = 'Connected. Create and import your Google client.';
    },
  ],
  [
    'import',
    async () => {
      const file = document.querySelector('#file').files[0];
      if (!file || file.size > 65536)
        throw new Error(
          'Select a Google client JSON file smaller than 64 KiB.',
        );
      await post('/import', { content: await file.text() });
      document.querySelector('#file').value = '';
      document.querySelector('#upload').hidden = true;
      status.textContent =
        'Client received. Continue in the installer terminal to save the configuration and start services.';
    },
  ],
]) {
  const form = document.getElementById(id);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = form.querySelector('button');
    button.disabled = true;
    error.textContent = '';
    status.textContent = 'Working. Please wait.';
    try {
      await action();
    } catch (failure) {
      error.textContent =
        failure.message ||
        'Connection failed. Keep the SSH tunnel open and retry.';
      status.textContent = '';
    } finally {
      button.disabled = false;
    }
  });
}
