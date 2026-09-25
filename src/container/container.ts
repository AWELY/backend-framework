import type { Token } from "./tokens";

type Factory<T> = (container: Container) => T;

interface Registration<T> {
  factory: Factory<T>;
  singleton: boolean;
  instance?: T;
}

/**
 * A deliberately small Dependency Injection container: register a token with a
 * factory, resolve it later (singleton by default). No decorators, no auto-wiring
 * by constructor reflection - callers pass the container in and pull what they
 * need, which is more code at each registration site but stays plain, debuggable
 * TypeScript instead of depending on a DI framework.
 */
export class Container {
  private readonly registrations = new Map<Token<unknown>, Registration<unknown>>();

  register<T>(token: Token<T>, factory: Factory<T>, options: { singleton?: boolean } = {}): void {
    this.registrations.set(token as Token<unknown>, {
      factory: factory as Factory<unknown>,
      singleton: options.singleton ?? true,
    });
  }

  resolve<T>(token: Token<T>): T {
    const registration = this.registrations.get(token as Token<unknown>);
    if (!registration) {
      throw new Error(`No provider registered for token: ${String(token)}`);
    }
    if (registration.singleton) {
      if (registration.instance === undefined) {
        registration.instance = registration.factory(this);
      }
      return registration.instance as T;
    }
    return registration.factory(this) as T;
  }

  has(token: Token<unknown>): boolean {
    return this.registrations.has(token as Token<unknown>);
  }
}
