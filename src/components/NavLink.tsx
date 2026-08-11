import {
  NavLink as RouterNavLink,
  NavLinkProps,
} from "react-router-dom";

import { forwardRef } from "react";

import { cn } from "@/lib/utils";


interface NavLinkCompatProps
  extends Omit<
    NavLinkProps,
    "className"
  > {

  className?:
    | string
    | ((
        args: {
          isActive: boolean;
          isPending: boolean;
        }
      ) => string);

  activeClassName?: string;

  pendingClassName?: string;

}


const NavLink = forwardRef<
  HTMLAnchorElement,
  NavLinkCompatProps
>(

  (
    {
      className,
      activeClassName,
      pendingClassName,
      ...props
    },

    ref
  ) => {

    return (

      <RouterNavLink

        ref={ref}

        {...props}

        className={(state) => {

          const baseClass =

            typeof className ===
            "function"

              ? className(state)

              : className;

          return cn(

            baseClass,

            state.isActive &&
              activeClassName,

            state.isPending &&
              pendingClassName

          );

        }}

      />

    );

  }

);


NavLink.displayName =
  "NavLink";


export { NavLink };