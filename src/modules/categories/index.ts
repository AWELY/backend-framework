import type { CommerceModule } from "../types";
import { validateBody } from "../../middleware/validate";
import { requirePermission } from "../../middleware/auth";
import { found, parsePagination } from "../shared";
import { categoriesMigrations, categoryInputSchema, type CategoryInput } from "./categories.schema";
import { CategoriesRepository, CATEGORIES_REPOSITORY } from "./categories.repository";

/**
 * Categories - flat (no nested sub-categories: a small store does not need a
 * tree, and a tree adds cycle checks and recursive queries).
 *
 *   GET    /categories           public
 *   GET    /categories/:id       public
 *   POST   /categories           categories:write
 *   PATCH  /categories/:id       categories:write
 *   DELETE /categories/:id       categories:write  (products keep existing, category_id becomes NULL)
 */
export const categoriesModule: CommerceModule = {
  name: "categories",
  migrations: categoriesMigrations,

  register({ router, container, pool, accessControl, authenticate }) {
    container.register(CATEGORIES_REPOSITORY, () => new CategoriesRepository(pool));
    const repo = () => container.resolve(CATEGORIES_REPOSITORY);
    const canWrite = requirePermission(accessControl, "categories:write");

    router.get("/categories", async (req, res) => {
      res.json(await repo().findAll(parsePagination(req.query)));
    });

    router.get("/categories/:id", async (req, res) => {
      res.json(found(await repo().findById(req.params.id as string), "Category"));
    });

    router.post("/categories", authenticate, canWrite, validateBody(categoryInputSchema), async (req, res) => {
      res.status(201).json(await repo().create(req.body as CategoryInput));
    });

    router.patch(
      "/categories/:id",
      authenticate,
      canWrite,
      validateBody(categoryInputSchema, { partial: true }),
      async (req, res) => {
        res.json(found(await repo().update(req.params.id as string, req.body as Partial<CategoryInput>), "Category"));
      }
    );

    router.delete("/categories/:id", authenticate, canWrite, async (req, res) => {
      found((await repo().delete(req.params.id as string)) ? true : null, "Category");
      res.status(204).end();
    });
  },
};
