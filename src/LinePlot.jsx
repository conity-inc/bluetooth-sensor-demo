import * as d3 from "d3";
import { useRef, useEffect } from "react";

/**
 * @param {{
 *   xdata: number[];
 *   ydata: number[][];
 *   yLim?: [number, number];
 *   width?: number;
 *   height?: number;
 *   marginTop?: number;
 *   marginRight?: number;
 *   marginBottom?: number;
 *   marginLeft?: number;
 * }} param0
 * @returns {import("react").ReactElement}
 */
export function LinePlot({
  xdata,
  ydata,
  yLim = [-1, 1],
  width = 400,
  height = 200,
  marginTop = 20,
  marginRight = 20,
  marginBottom = 30,
  marginLeft = 40,
}) {
  const colors = ["#e44", "#4e4", "#44e", "#888"];
  const gx = useRef();
  const gy = useRef();
  const x = d3.scaleLinear(d3.extent(xdata), [marginLeft, width - marginRight]);
  const y = d3.scaleLinear(yLim, [height - marginBottom, marginTop]);
  const line = d3.line(
    (d, i) => x(xdata[i]),
    (d) => y(d)
  );
  useEffect(() => void d3.select(gx?.current).call(d3.axisBottom(x)), [gx, x]);
  useEffect(() => void d3.select(gy?.current).call(d3.axisLeft(y)), [gy, y]);
  return (
    <svg width={width} height={height}>
      <g ref={gx} transform={`translate(0,${height - marginBottom})`} />
      <g ref={gy} transform={`translate(${marginLeft},0)`} />
      {ydata.map((yd, i) => {
        const color = colors[i];
        return (
          <g key={i}>
            <path fill="none" stroke={color} strokeWidth="1.5" d={line(yd)} />
            {/* <g fill={color} stroke={color} strokeWidth="1">
              {yd
                .map((d, i) => [d, i])
                .filter(([_, i]) => i % 10 === 0)
                .map(([d, i]) => (
                  <circle key={i} cx={x(xdata[i])} cy={y(d)} r="1" />
                ))}
            </g> */}
          </g>
        );
      })}
    </svg>
  );
}
