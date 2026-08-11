// src/pages/NotFound.tsx

import { useLocation, Link } from "react-router-dom";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { PageContainer, ContentContainer } from "@/components/Layout";

const NotFound = () => {
  const location = useLocation();

  useEffect(() => {
    console.error(
      "404 Error: User attempted to access non-existent route:",
      location.pathname
    );
  }, [location.pathname]);

  return (
    <PageContainer>
      <main className="aeterna-main flex items-center justify-center">
        <ContentContainer>
          <div className="text-center">
            <h1 className="font-display aeterna-heading-hero mb-6">
              404
            </h1>

            <p className="text-xl text-muted-foreground mb-6">
              Oops! Page not found
            </p>

            <Button asChild>
              <Link to="/">Back to Home</Link>
            </Button>
          </div>
        </ContentContainer>
      </main>
    </PageContainer>
  );
};

export default NotFound;
