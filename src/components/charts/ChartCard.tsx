import * as React from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ResponsiveContainer, Tooltip } from "recharts"
import { cn } from "@/lib/utils"

export const chartTooltip = {
  contentStyle: {
    background: "hsl(var(--card))",
    border: "1px solid hsl(var(--border))",
    borderRadius: "8px",
    fontSize: 12,
    color: "hsl(var(--card-foreground))",
  } as React.CSSProperties,
  labelStyle: { color: "hsl(var(--muted-foreground))", fontWeight: 600 } as React.CSSProperties,
  itemStyle: { color: "#ed1c24" } as React.CSSProperties,
  cursor: { stroke: "hsl(var(--border))", strokeDasharray: "3 3" } as Record<string, string>,
}

type Props = {
  title: string
  subtitle?: string
  height?: number
  className?: string
  action?: React.ReactNode
  children: React.ReactElement
}

export function ChartCard({ title, subtitle, height = 320, className, action, children }: Props) {
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
