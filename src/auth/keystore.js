import keytar from 'keytar';

const SERVICE = 'nepali-wallet-cli';

export async function saveCredentials(provider, phone, password) {
  await keytar.setPassword(SERVICE, `${provider}:${phone}`, password);
  await keytar.setPassword(SERVICE, `${provider}:active`, phone);
}

export async function getCredentials(provider) {
  const phone = await keytar.getPassword(SERVICE, `${provider}:active`);
  if (!phone) return null;
  const password = await keytar.getPassword(SERVICE, `${provider}:${phone}`);
  if (!password) return null;
  return { phone, password };
}

export async function clearCredentials(provider) {
  const phone = await keytar.getPassword(SERVICE, `${provider}:active`);
  if (phone) {
    await keytar.deletePassword(SERVICE, `${provider}:${phone}`);
  }
  await keytar.deletePassword(SERVICE, `${provider}:active`);
}

export async function hasCredentials(provider) {
  const creds = await getCredentials(provider);
  return creds !== null;
}
