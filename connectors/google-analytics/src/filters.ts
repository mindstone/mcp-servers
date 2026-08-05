/**
 * GA4 Data API filter expression schema.
 *
 * dimensionFilter / metricFilter inputs were previously accepted as z.any(),
 * which passed arbitrary values straight into the request body. Filter
 * expressions are now fail-closed validated against the recursive GA4
 * FilterExpression structure before they are sent.
 */

import { z } from 'zod';

const metricValueSchema = z
  .object({
    int64Value: z.union([z.string(), z.number()]).optional(),
    doubleValue: z.number().optional(),
  })
  .strict();

const filterSchema = z
  .object({
    fieldName: z.string().min(1),
    stringFilter: z
      .object({
        matchType: z.string().optional(),
        value: z.string(),
        caseSensitive: z.boolean().optional(),
      })
      .strict()
      .optional(),
    inListFilter: z
      .object({
        values: z.array(z.string()).min(1),
        caseSensitive: z.boolean().optional(),
      })
      .strict()
      .optional(),
    numericFilter: z
      .object({
        operation: z.string().optional(),
        value: metricValueSchema,
      })
      .strict()
      .optional(),
    betweenFilter: z
      .object({
        fromValue: metricValueSchema,
        toValue: metricValueSchema,
      })
      .strict()
      .optional(),
    emptyFilter: z.object({}).strict().optional(),
  })
  .strict();

export interface FilterExpression {
  andGroup?: { expressions: FilterExpression[] };
  orGroup?: { expressions: FilterExpression[] };
  notExpression?: FilterExpression;
  filter?: z.infer<typeof filterSchema>;
}

/** Recursive GA4 FilterExpression — accepts nested and/or/not groups. */
export const filterExpressionSchema: z.ZodType<FilterExpression> = z.lazy(() =>
  z
    .object({
      andGroup: z
        .object({ expressions: z.array(filterExpressionSchema).min(1) })
        .strict()
        .optional(),
      orGroup: z
        .object({ expressions: z.array(filterExpressionSchema).min(1) })
        .strict()
        .optional(),
      notExpression: filterExpressionSchema.optional(),
      filter: filterSchema.optional(),
    })
    .strict(),
);
