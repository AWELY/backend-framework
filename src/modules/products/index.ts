import type { CommerceModule } from "../types";
import { validateBody } from "../../middleware/validate";
import { requirePermission } from "../../middleware/auth";
import { found, parsePagination } from "../shared";
import { productsMigrations, productInputSchema, type ProductInput } from "./products.schema";
import { ProductsRepository, PRODUCTS_REPOSITORY } from "./products.repository";

/**
 * Products.
 *
 *   GET    /products?categoryId=&limit=&offset=   public (active only); owner also sees inactive
 *   GET    /products/:id                          public (active only); owner also sees inactive
 *   POST   /products                              products:write
 *   PATCH  /products/:id                          products:write
 *   DELETE /products/:id                          products:write
 *
 * Stock is NOT stored here - it belongs to the Inventory module, so Products
 * does not depend on Inventory (Inventory depends on Products instead).
 */
export const productsModule: CommerceModule = {
  name: "products",
  migrations: productsMigrations,

  register({ router, container, pool, accessControl, authenticate, authenticateOptional }) {
    container.register(PRODUCTS_REPOSITORY, () => new ProductsRepository(pool));
    const repo = () => container.resolve(PRODUCTS_REPOSITORY);
    const canWrite = requirePermission(accessControl, "products:write");

    router.get("/products", authenticateOptional, async (req, res) => {
      const { limit, offset } = parsePagination(req.query);
      res.json(
        await repo().list({
          categoryId: req.query.get("categoryId") ?? undefined,
          includeInactive: accessControl.can(req.auth?.role, "products:write"),
          limit,
          offset,
        })
      );
    });

    router.get("/products/:id", authenticateOptional, async (req, res) => {
      const product = await repo().findById(req.params.id as string);
      const visible = product && (product.isActive || accessControl.can(req.auth?.role, "products:write"));
      res.json(found(visible ? product : null, "Product"));
    });

    router.post("/products", authenticate, canWrite, validateBody(productInputSchema), async (req, res) => {
      res.status(201).json(await repo().create(req.body as ProductInput));
    });

    router.patch(
      "/products/:id",
      authenticate,
      canWrite,
      validateBody(productInputSchema, { partial: true }),
      async (req, res) => {
        res.json(found(await repo().update(req.params.id as string, req.body as Partial<ProductInput>), "Product"));
      }
    );

    router.delete("/products/:id", authenticate, canWrite, async (req, res) => {
      found((await repo().delete(req.params.id as string)) ? true : null, "Product");
      res.status(204).end();
    });
  },
};
