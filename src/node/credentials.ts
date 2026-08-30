import { AgentVError, type CredentialResolver, type CredentialStore } from "../core/index.js";

export class EnvironmentCredentialResolver implements CredentialResolver {
  constructor(private readonly environment: Readonly<Record<string, string | undefined>> = process.env) {}

  async resolve(reference: string): Promise<string | undefined> {
    if (!reference.startsWith("env://")) return undefined;
    const name = reference.slice("env://".length);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new AgentVError("configuration-invalid", "Environment credential references must name one variable.");
    return this.environment[name]?.trim() || undefined;
  }
}

export class CompositeCredentialResolver implements CredentialResolver {
  constructor(private readonly resolvers: readonly CredentialResolver[]) {}

  async resolve(reference: string): Promise<string | undefined> {
    for (const resolver of this.resolvers) {
      const value = await resolver.resolve(reference);
      if (value) return value;
    }
    return undefined;
  }
}

export interface SystemCredentialStoreOptions {
  /** Stable application identifier shown by the operating-system credential manager. */
  service: string;
}

export interface SystemCredentialStoreReadiness {
  availability: "ready" | "unavailable";
  backend: "system-keyring";
  detail: string;
}

type KeyringModule = typeof import("@napi-rs/keyring");

function accountFor(reference: string): string | undefined {
  if (!reference.startsWith("keychain://")) return undefined;
  const account = reference.slice("keychain://".length);
  if (!account || account.length > 200 || !/^[A-Za-z0-9._:@/-]+$/.test(account)) {
    throw new AgentVError("configuration-invalid", "Keychain credential references contain an invalid account name.");
  }
  return account;
}

async function loadKeyring(): Promise<KeyringModule> {
  try { return await import("@napi-rs/keyring"); }
  catch { throw new AgentVError("engine-unavailable", "The operating-system credential store is unavailable on this device."); }
}

/** Native macOS Keychain, Windows Credential Manager, or Linux Secret Service storage. */
export class SystemCredentialStore implements CredentialStore {
  private readonly service: string;

  constructor(options: SystemCredentialStoreOptions) {
    this.service = options.service.trim();
    if (!this.service || this.service.length > 200 || /[\u0000-\u001f\u007f]/.test(this.service)) {
      throw new TypeError("Credential service must be a non-empty printable string up to 200 characters.");
    }
  }

  async inspect(): Promise<SystemCredentialStoreReadiness> {
    try {
      await loadKeyring();
      return { availability: "ready", backend: "system-keyring", detail: "The native credential-store binding is installed. Access is verified when a credential is used." };
    } catch {
      return { availability: "unavailable", backend: "system-keyring", detail: "The operating-system credential store is unavailable. No plaintext fallback is enabled." };
    }
  }

  async resolve(reference: string): Promise<string | undefined> {
    const account = accountFor(reference);
    if (!account) return undefined;
    const { AsyncEntry } = await loadKeyring();
    try { return await new AsyncEntry(this.service, account).getPassword() ?? undefined; }
    catch { throw new AgentVError("engine-unavailable", "The operating-system credential store could not read this credential."); }
  }

  async set(reference: string, value: string): Promise<void> {
    const account = accountFor(reference);
    if (!account) throw new AgentVError("configuration-invalid", "System credentials require a keychain:// reference.");
    if (!value) throw new TypeError("Credential value must not be empty.");
    const { AsyncEntry } = await loadKeyring();
    try { await new AsyncEntry(this.service, account).setPassword(value); }
    catch { throw new AgentVError("engine-unavailable", "The operating-system credential store rejected the credential update."); }
  }

  async delete(reference: string): Promise<boolean> {
    const account = accountFor(reference);
    if (!account) throw new AgentVError("configuration-invalid", "System credentials require a keychain:// reference.");
    const { AsyncEntry } = await loadKeyring();
    try { return await new AsyncEntry(this.service, account).deleteCredential(); }
    catch { throw new AgentVError("engine-unavailable", "The operating-system credential store could not delete this credential."); }
  }
}
