import { motion } from "framer-motion"
import { Button } from "@/components/ui/button"
import { Link, useNavigate } from "react-router-dom"

const Home = () => {
  const navigate = useNavigate()

  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-6 pb-28 sm:pb-24 md:pb-20 relative overflow-hidden">

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
            border-amber-500/40
            dark:border-amber-400/30
            bg-gradient-to-b
            from-[hsl(220,35%,10%)]
            via-[hsl(220,35%,7%)]
            to-[hsl(220,35%,5%)]
            shadow-[inset_0_1px_0_rgba(255,200,140,0.08)]
            shadow-[0_0_0_1px_rgba(255,180,90,0.12),0_0_70px_rgba(255,180,90,0.22)]
            dark:shadow-[0_0_0_1px_rgba(255,180,90,0.1),0_0_60px_rgba(255,180,90,0.16)]
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
              <div className="relative w-8 sm:w-9 xl:w-10">
                {/* Soft glow layer, kept separate so the icon itself stays crisp */}
                <motion.div
                  animate={{ opacity: [0.35, 0.55, 0.35] }}
                  transition={{ duration: 4, repeat: Infinity, ease: "easeInOut" }
                  }
                  className="
                    absolute inset-0
                    rounded-full
                    blur-md
                    bg-amber-400/25
                  "
                />
                {/* Crisp icon */}
                <div
                  className="
                    relative
                    w-8 h-14
                    sm:w-9 sm:h-16
                    xl:w-10 xl:h-18
                    rounded-full
                    border
                    border-amber-400/80
                    bg-gradient-to-b
                    from-amber-400/10
                    to-transparent
                    overflow-hidden
                  "
                >
                  <div className="absolute inset-x-2 top-3 h-px bg-amber-300/60" />
                  <div className="absolute inset-x-0 top-1/2 h-px bg-amber-300/40" />
                </div>
              </div>
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
                text-amber-50
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
                text-amber-100/70
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
              transition={{ duration: 0.8, delay: 0.6 }
              }
              className="
                text-[12px]
                md:text-[13px]
                xl:text-[14px]
                text-amber-100/50
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
              transition={{ duration: 0.8, delay: 0.7 }
              }
              className="w-full max-w-[220px] sm:max-w-[240px] xl:max-w-[260px]"
            >
              <Button
                type="button"
                className="
                  w-full
                  h-11
                  sm:h-12
                  xl:h-12
                  bg-[hsl(220,35%,9%)]
                  text-amber-300
                  border
                  border-amber-400/50
                  text-[11px]
                  sm:text-[12px]
                  xl:text-[13px]
                  font-medium
                  tracking-[0.18em]
                  shadow-[0_0_18px_rgba(255,180,90,0.25),inset_0_0_12px_rgba(255,180,90,0.06)]
                  transition-all
                  duration-300
                  ease-out
                  hover:bg-[hsl(220,35%,11%)]
                  hover:text-amber-200
                  hover:border-amber-300/70
                  hover:scale-x-[1.04]
                  hover:shadow-[0_0_32px_rgba(255,180,90,0.45),inset_0_0_16px_rgba(255,180,90,0.1)]
                "
                onClick={() => navigate("/create")}
              >
                CREATE CAPSULE
              </Button>
            </motion.div>

            {/* Small text */}
            <motion.p
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.8, delay: 0.9 }
              }
              className="
                mt-6
                text-[11px]
                md:text-[12px]
                xl:text-[13px]
                text-amber-100/40
                tracking-wide
              "
            >
              No accounts · No recovery · One private link
            </motion.p>

            {/* Protocol link */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.8, delay: 1.0 }
              }
              className="mt-7 xl:mt-8"
            >
              <Link
                to="/protocol"
                className="
                  text-[11px]
                  md:text-[12px]
                  xl:text-[13px]
                  text-amber-300/90
                  hover:text-amber-200
                  hover:drop-shadow-[0_0_10px_rgba(255,180,90,0.5)]
                  transition-all
                  duration-300
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

      {/* Footer + X link — сгруппированы, чтобы отступ между ними был всегда одинаковым и адаптивным на любом экране */}
      <footer
        className="
          absolute
          bottom-4
          sm:bottom-5
          md:bottom-6
          lg:bottom-8
          left-0 right-0
          flex flex-col items-center
          gap-3
          sm:gap-4
          px-6
        "
      >
        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.8, delay: 1.2 }
          }
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

        <motion.a
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.8, delay: 1.3 }
          }
          href="https://x.com/aeternacapsule"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="X (Twitter)"
          className="
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
      </footer>
    </div>
  );
};

export default Home;