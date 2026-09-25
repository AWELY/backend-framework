/**
 * A Token is just a unique Symbol carrying a phantom type, so Container.resolve()
 * can return the right TypeScript type without any decorators or reflect-metadata
 * (which would need "experimentalDecorators" + a metadata polyfill - real weight
 * for what this project needs). Modules will export their own tokens, e.g.:
 *
 *   export const PRODUCTS_REPOSITORY = createToken<ProductsRepository>("ProductsRepository");
 */
export type Token<T> = symbol & { readonly __type?: T };

export function createToken<T>(description: string): Token<T> {
  return Symbol(description) as Token<T>;
}
