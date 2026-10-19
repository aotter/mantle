/** Presentation only: the report and its data tool share salesPage's authorized reader. */
export const salesReportCatalogue = {
  views: {
    render_sales_report: {
      columns: { name: { type: "string" }, orders: { type: "integer" }, units: { type: "integer" } },
      list: { columns: ["name", "orders", "units"] },
      actions: [],
    },
  },
  actions: {},
} as const;
