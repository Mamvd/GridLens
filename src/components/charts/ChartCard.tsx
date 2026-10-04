import * as React from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ResponsiveContainer, Tooltip } from "recharts"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { srTableModel, type SrSeriesInput } from "@/lib/sr-table"
import { cn } from "@/lib/utils"

export const chartTooltip = {
  contentStyle: {
    backgroundColor: "var(--card)",
    border: "1px solid var(--border)",
    borderRadius: "8px",
    fontSize: 12,
    color: "var(--card-foreground)",
  } as React.CSSProperties,
  labelStyle: { color: "var(--muted-foreground)", fontWeight: 600 } as React.CSSProperties,
  itemStyle: { color: "var(--chart-1)" } as React.CSSProperties,
  cursor: { stroke: "var(--border)", strokeDasharray: "3 3" } as Record<string, string>,
}

/** Screen-reader-only data table for a chart: `xLabels` = x-axis values,
 *  `series` = one entry per line/bar (data aligned with xLabels). Null when
 *  empty. Pure model lives in lib/sr-table; this is the JSX render. */
export function buildSrTable(
  xLabels: readonly (string | number)[],
  series: readonly SrSeriesInput[],
) {
  const model = srTableModel(xLabels, series);
  if (!model) return null;
  return (
    <Table className="sr-only" aria-label="Chart data table">
      <TableHeader>
        <TableRow>
          <TableHead scope="col">Series</TableHead>
          {model.headers.map((lbl, i) => <TableHead key={`${lbl}-${i}`} scope="col">{lbl}</TableHead>)}
        </TableRow>
      </TableHeader>
      <TableBody>
        {model.rows.map((r) => (
          <TableRow key={r.name}>
            <TableCell scope="row" className="font-medium">{r.name}</TableCell>
            {r.cells.map((c, i) => (
              <TableCell key={i} className="tabular-nums">{c}</TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

type Props = {
  title: string
  subtitle?: string
  /** one-sentence screen-reader description of what the chart shows */
  srSummary?: string
  /** Optional: pre-built sr-only table (built via buildSrTable) */
  srTable?: React.ReactNode
  height?: number
  className?: string
  action?: React.ReactNode
  children: React.ReactElement
}

export function ChartCard({ title, subtitle, srSummary, srTable, height = 320, className, action, children }: Props) {
  return (
    <Card className={cn(className)}>
      <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-2">
        <div className="space-y-1">
          <CardTitle className="text-sm font-semibold tracking-tight">{title}</CardTitle>
          {subtitle ? <CardDescription className="text-xs">{subtitle}</CardDescription> : null}
        </div>
        {action}
      </CardHeader>
      <CardContent>
        {srSummary ? <p className="sr-only">{srSummary}</p> : null}
        {srTable}
        <div style={{ width: "100%", height }}>
          <ResponsiveContainer width="100%" height="100%">{children}</ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  )
}

// Re-export Tooltip with dark defaults for convenience
export const ChartTooltip = (props: React.ComponentProps<typeof Tooltip>) => (
  <Tooltip
    contentStyle={chartTooltip.contentStyle}
    labelStyle={chartTooltip.labelStyle}
    itemStyle={chartTooltip.itemStyle}
    cursor={chartTooltip.cursor}
    {...props}
  />
)
