import * as React from "react";

const MOBILE_BREAKPOINT = 768;

export function useIsMobile(): boolean {

  const [isMobile, setIsMobile] =
    React.useState<boolean>(() => {

      if (typeof window === "undefined") {

        return false;

      }

      return window.matchMedia(
        `(max-width: ${MOBILE_BREAKPOINT - 1}px)`
      ).matches;

    });


  React.useEffect(() => {

    if (typeof window === "undefined") {

      return;

    }

    const mql =
      window.matchMedia(
        `(max-width: ${MOBILE_BREAKPOINT - 1}px)`
      );


    const onChange = (
      event: MediaQueryListEvent
    ) => {

      setIsMobile(event.matches);

    };


    setIsMobile(mql.matches);


    if (mql.addEventListener) {

      mql.addEventListener(
        "change",
        onChange
      );

      return () =>
        mql.removeEventListener(
          "change",
          onChange
        );

    }


    // Safari fallback

    mql.addListener(onChange);

    return () =>
      mql.removeListener(onChange);

  }, []);


  return isMobile;

}