import { motion } from "framer-motion";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";

const Home = () => {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-6 relative overflow-hidden">

      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 1.2, ease: "easeOut" }}
        className="
          relative z-10 w-full
          max-w-[300px]
          sm:max-w-[340px]
          md:max-w-[380px]
          lg:max-w-[420px]
          xl:max-w-[460px]
          2xl:max-w-[500px]
          -mt-6 md:mt-0
        "
      >
        <div
          className="
            relative
            rounded-[72px]
            sm:rounded-[80px]
            xl:rounded-[100px]
            border
            border-accent/25
            dark:border-accent/15
            bg-gradient-to-b
            from-accent/[0.05]
            via-transparent
            to-accent/[0.03]
            shadow-[inset_0_1px_0_rgba(255,255,255,0.6)]
            shadow-[0_0_0_1px_rgba(255,200,140,0.08),0_0_60px_rgba(255,200,140,0.18)]
            dark:shadow-[0_0_40px_-15px_hsl(var(--accent)/0.15)]
            px-7
            pt-12
            pb-14
            sm:px-8
            sm:pt-14
            sm:pb-16
            md:pt-16
            md:pb-18
            lg:px-10
            lg:pt-18
            lg:pb-20
            xl:px-12
            xl:pt-20
            xl:pb-24
          "
        >
          <div className="flex flex-col items-center text-center">
            {/* Capsule icon */}
            <motion.div
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.8, delay: 0.2 }}
              className="mb-6 xl:mb-8"
            >
              <motion.div
                animate={{ opacity: [0.6, 0.8, 0.6] }}
                transition={{ duration: 4, repeat: Infinity, ease: "easeInOut" }}
              >
                <div
                  className="
                    w-8 h-14
                    sm:w-9 sm:h-16
                    xl:w-10 xl:h-18
                    rounded-full
                    border
                    border-accent/30
                    bg-gradient-to-b
                    from-accent/5
                    to-transparent
                    relative
                    overflow-hidden
                  "
                >
                  <div className="absolute inset-x-2 top-3 h-px bg-accent/20" />
                  <div className="absolute inset-x-0 top-1/2 h-px bg-accent/15" />
                </div>
              </motion.div>
            </motion.div>

            {/* Title */}
            <motion.h1
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.8, delay: 0.3 }}
              className="
                font-display
                text-[22px]
                sm:text-[24px]
                md:text-[27px]
                xl:text-[30px]
                font-medium
                text-foreground
                tracking-[0.18em]
                mb-3
              "
            >
              AETERNA CAPSULE
            </motion.h1>

            {/* Subtitle */}
            <motion.p
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.8, delay: 0.5 }}
              className="
                text-muted-foreground/80
                text-[13px]
                md:text-[14px]
                xl:text-[15px]
                leading-relaxed
                mb-3
              "
            >
              Preserve a moment. Unlock it in the future.
            </motion.p>

            {/* Why text */}
            <motion.p
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.8, delay: 0.6 }}
              className="
                text-[12px]
                md:text-[13px]
                xl:text-[14px]
                text-muted-foreground/70
                tracking-wide
                mb-8
              "
            >
              Time decides. Not people. Not servers.
            </motion.p>

            {/* Button */}
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.8, delay: 0.7 }}
              className="w-full max-w-[220px] sm:max-w-[240px] xl:max-w-[260px]"
            >
              <Button
                asChild
                className="
                  w-full
                  h-11
                  sm:h-12
                  xl:h-12
                  bg-foreground
                  text-background
                  text-[11px]
                  sm:text-[12px]
                  xl:text-[13px]
                  font-medium
                  tracking-[0.18em]
                  hover:bg-foreground/90
                  transition-all
                "
              >
                <Link to="/create">CREATE CAPSULE</Link>
              </Button>
            </motion.div>

            {/* Small text */}
            <motion.p
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.8, delay: 0.9 }}
              className="
                mt-6
                text-[11px]
                md:text-[12px]
                xl:text-[13px]
                text-muted-foreground/60
                tracking-wide
              "
            >
              No accounts · No recovery · One private link
            </motion.p>

            {/* Protocol link */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.8, delay: 1.0 }}
              className="mt-7 xl:mt-8"
            >
              <Link
                to="/protocol"
                className="
                  text-[11px]
                  md:text-[12px]
                  xl:text-[13px]
                  text-muted-foreground/80
                  hover:text-foreground
                  transition-colors
                  tracking-wide
                  underline
                  underline-offset-4
                "
              >
                Read the Protocol Rules →
              </Link>
            </motion.div>
          </div>
        </div>
      </motion.div>

      {/* Footer */}
      <footer className="absolute bottom-12 left-0 right-0 flex justify-center px-6">
        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.8, delay: 1.2 }}
          className="
            w-full
            max-w-[300px]
            sm:max-w-[340px]
            md:max-w-[380px]
            lg:max-w-[420px]
            xl:max-w-[460px]
            2xl:max-w-[500px]
            text-xs
            text-muted-foreground/65
            tracking-wide
            text-center
            leading-relaxed
          "
        >
          A non-custodial digital time capsule
        </motion.p>
      </footer>

      {/* X (Twitter) link — теперь всегда по центру */}
      <motion.a
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.8, delay: 1.3 }}
        href="https://x.com/aeternacapsule"
        target="_blank"
        rel="noopener noreferrer"
        aria-label="X (Twitter)"
        className="
          absolute
          bottom-6
          left-1/2
          -translate-x-1/2
          flex
          items-center
          justify-center
          text-muted-foreground/45
          hover:text-muted-foreground/75
          transition-colors
          duration-300
        "
      >
        <svg viewBox="0 0 24 24" className="w-4 h-4" fill="currentColor">
          <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
        </svg>
      </motion.a>
    </div>
  );
};

export default Home;