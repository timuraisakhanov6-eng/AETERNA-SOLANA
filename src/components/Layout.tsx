import { ReactNode } from "react";

interface LayoutProps {
  children: ReactNode;
  className?: string;
}


/**
 * PAGE ROOT
 */
export const PageContainer = ({
  children,
  className = "",
}: LayoutProps) => (

  <div
    className={`aeterna-page ${className}`}
    style={{
      minHeight: "100dvh",
      display: "flex",
      flexDirection: "column",
    }}
  >

    {children}

  </div>

);


/**
 * CONTENT WIDTH CONTAINER
 */
export const ContentContainer = ({
  children,
  className = "",
}: LayoutProps) => (

  <div
    className={`aeterna-container ${className}`}
    style={{
      width: "100%",
      maxWidth: "960px",
      margin: "0 auto",
      paddingLeft: 16,
      paddingRight: 16,
    }}
  >

    {children}

  </div>

);


/**
 * HEADER (simple, not sticky)
 */
export const PageHeader = ({
  children,
  className = "",
}: LayoutProps) => (

  <header
    role="banner"
    className={className}
    style={{
      height: 56,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      borderBottom:
        "1px solid rgba(255,255,255,0.08)",
    }}
  >

    <ContentContainer>

      {children}

    </ContentContainer>

  </header>

);


/**
 * MAIN
 */
export const PageMain = ({
  children,
  className = "",
}: LayoutProps) => (

  <main
    className={className}
    style={{
      flex: 1,
      paddingTop: 32,
      paddingBottom: 64,
    }}
  >

    <ContentContainer>

      {children}

    </ContentContainer>

  </main>

);