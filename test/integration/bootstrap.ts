import { assertLoopback, waitForHttp } from 'mcp-integration-harness';

/**
 * Waits for the throwaway ntfy and hands back the credentials to drive it with.
 *
 * Shorter than the other bootstraps in this family because ntfy's account
 * creation is a CLI command rather than an endpoint, so it happens in
 * `compose.yml` where the container can run it. What is left here is the wait
 * and the loopback check.
 *
 * **Basic auth, not a token**, and that is deliberate: minting a token needs
 * `ntfy token add`, whose output would have to be captured out of the
 * container. Both credential kinds go through the same code path in
 * `src/api.ts`, and the token path is covered by the unit tests.
 */

export const ADMIN_USERNAME = 'integration';
export const ADMIN_PASSWORD = 'integration-not-a-secret';

/** The topic the suite publishes to. Nothing else uses it. */
export const TOPIC = 'integration-topic';

export interface Sandbox {
  url: string;
  username: string;
  password: string;
  topic: string;
}

export async function bootstrap(
  url = 'http://127.0.0.1:8099'
): Promise<Sandbox> {
  assertLoopback(url);
  await waitForHttp(`${url}/v1/health`, {
    timeoutSeconds: 120,
    ready: (response) => response.ok,
  });

  // The health endpoint answers before `ntfy user add` has run — it is a
  // separate command against a server that is already listening. Waiting for
  // the account rather than for the port is the difference between a suite
  // that is flaky on a cold machine and one that is not.
  const deadline = Date.now() + 60_000;
  for (;;) {
    const response = await fetch(`${url}/v1/account`, {
      headers: { authorization: basic(ADMIN_USERNAME, ADMIN_PASSWORD) },
      signal: AbortSignal.timeout(5000),
    });
    if (response.ok) {
      const account = (await response.json()) as { role?: string };
      if (account.role === 'admin') break;
      throw new Error(
        `the ${ADMIN_USERNAME} account exists but its role is ` +
          `${String(account.role)}; the admin tools need an admin`
      );
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `the ${ADMIN_USERNAME} account never appeared (last HTTP ` +
          `${response.status}). \`docker compose logs\` shows whether ` +
          '`ntfy user add` ran.'
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return {
    url,
    username: ADMIN_USERNAME,
    password: ADMIN_PASSWORD,
    topic: TOPIC,
  };
}

function basic(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}
