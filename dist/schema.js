import { z } from "zod";
/**
 * Canonical, source-agnostic job shape. Every source adapter must map its
 * raw payload into this shape. Keeping this strict (not `.passthrough()`)
 * means that if a source changes its response structure, validation fails
 * loudly instead of silently passing `undefined` fields downstream.
 */
export const NormalizedJobSchema = z.object({
    sourceId: z.string().min(1),
    externalId: z.string().min(1), // id as given by the source, for de-dupe
    title: z.string().min(1),
    company: z.string().min(1),
    location: z.string().min(1),
    url: z.string().url(),
    postedAt: z.string().datetime().optional(),
    tags: z.array(z.string()).default([]),
    salaryRaw: z.string().optional(),
    fetchedAt: z.string().datetime(),
});
//# sourceMappingURL=schema.js.map