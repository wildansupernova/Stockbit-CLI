import type { FundamentalResponse } from "./fundamental.js";

export const FINANCIAL_CSV_COLUMNS = [
  "schema_version",
  "source",
  "symbol",
  "report",
  "report_type",
  "statement",
  "statement_type",
  "data_type",
  "currencies",
  "default_currency",
  "selected_currency",
  "total_periods",
  "rounding_values",
  "table_id",
  "table_kind",
  "unit_label",
  "row_id",
  "row_kind",
  "label",
  "local_label",
  "display_label",
  "hidden",
  "tree_left",
  "tree_right",
  "period",
  "period_label",
  "available",
  "display",
  "raw",
  "idr",
  "usd",
  "percentage",
  "parser_warnings",
  "fetched_at",
] as const;

type FinancialCsvColumn = (typeof FINANCIAL_CSV_COLUMNS)[number];
type CsvValue = string | number | boolean | null | undefined;
type FinancialCsvRecord = Record<FinancialCsvColumn, CsvValue>;
type CsvFundamentalResponse = Extract<FundamentalResponse, { view: "csv" }>;

function encodeCsvCell(value: CsvValue): string {
  if (value === null || value === undefined) {
    return "";
  }

  const text = String(value);
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function serializeFundamentalCsv(response: CsvFundamentalResponse): string {
  const lines = [FINANCIAL_CSV_COLUMNS.join(",")];
  const shared = {
    schema_version: response.schema_version,
    source: response.meta.source,
    symbol: response.meta.symbol,
    report: response.meta.report,
    report_type: response.meta.report_type,
    statement: response.meta.statement,
    statement_type: response.meta.statement_type,
    data_type: response.meta.data_type,
    currencies: response.data.currencies.join("|"),
    default_currency: response.data.default_currency,
    selected_currency: response.data.selected_currency,
    total_periods: response.data.total_periods,
    rounding_values: response.data.rounding_values.join("|"),
    parser_warnings: response.meta.parser.warnings.join(" | "),
    fetched_at: response.meta.fetched_at,
  };

  for (const table of response.data.tables) {
    const periodLabels = new Map(
      table.periods.map((period) => [period.key, period.label]),
    );

    for (const row of table.rows) {
      for (const value of row.values) {
        const record: FinancialCsvRecord = {
          ...shared,
          table_id: table.id,
          table_kind: table.kind,
          unit_label: table.unit_label,
          row_id: row.id,
          row_kind: row.kind,
          label: row.label,
          local_label: row.local_label,
          display_label: row.display_label,
          hidden: row.hidden,
          tree_left: row.tree?.left,
          tree_right: row.tree?.right,
          period: value.period,
          period_label: periodLabels.get(value.period) ?? value.period,
          available: value.available,
          display: value.display,
          raw: value.raw,
          idr: value.idr,
          usd: value.usd,
          percentage: value.percentage,
        };
        lines.push(
          FINANCIAL_CSV_COLUMNS.map((column) => encodeCsvCell(record[column])).join(","),
        );
      }
    }
  }

  return lines.join("\r\n");
}
