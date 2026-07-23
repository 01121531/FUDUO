"use client";

import { cloneElement, useId, type ReactElement } from "react";

type TooltipSide = "top" | "right" | "bottom" | "left";
type TooltipChild = ReactElement<{ "aria-describedby"?: string }>;

export function Tooltip({ label, side = "top", className = "", children }: {
  label: string;
  side?: TooltipSide;
  className?: string;
  children: TooltipChild;
}) {
  const id = useId();
  const describedBy = [children.props["aria-describedby"], id].filter(Boolean).join(" ");

  return (
    <span className={`tooltip tooltip-${side}${className ? ` ${className}` : ""}`}>
      {cloneElement(children, { "aria-describedby": describedBy })}
      <span className="tooltip-content" id={id} role="tooltip">{label}</span>
    </span>
  );
}
