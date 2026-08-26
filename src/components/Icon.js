import React from "react";
import "./icon.css";

export default function Icon({ as: IconComponent, size = 20, color, className = "", ariaLabel, style = {} }) {
  if (!IconComponent) {
    return null;
  }
  const role = ariaLabel ? "img" : "presentation";
  const props = {
    size,
    color,
    className: `modern-icon ${className}`.trim(),
    style,
    role,
  };
  if (ariaLabel) props["aria-label"] = ariaLabel;

  if (React.isValidElement(IconComponent)) {
    return React.cloneElement(IconComponent, props);
  }

  if (typeof IconComponent === "function") {
    return <IconComponent {...props} />;
  }

  if (
    typeof IconComponent === "object" &&
    IconComponent !== null &&
    (IconComponent.$$typeof || typeof IconComponent.render === "function")
  ) {
    return <IconComponent {...props} />;
  }

  return null;
}
