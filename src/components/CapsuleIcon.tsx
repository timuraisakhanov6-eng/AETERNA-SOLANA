import { motion, useReducedMotion } from "framer-motion";

interface CapsuleIconProps {
  isLocked?: boolean;
  size?: "sm" | "md" | "lg";
  animate?: boolean;
}

export const CapsuleIcon = ({
  isLocked = true,
  size = "md",
  animate = true,
}: CapsuleIconProps) => {

  const prefersReducedMotion =
    useReducedMotion();

  const shouldAnimate =
    animate && !prefersReducedMotion;


  const sizeClasses = {
    sm: "w-16 h-16",
    md: "w-24 h-24",
    lg: "w-32 h-32",
  } as const;


  return (

    <motion.div
      className={`${sizeClasses[size]} relative`}
      animate={
        shouldAnimate
          ? { y: [0, -5, 0] }
          : false
      }
      transition={{
        duration: 4,
        repeat: Infinity,
        ease: "easeInOut",
      }}
    >

      {/* Capsule body */}

      <div className="absolute inset-0 rounded-full bg-gradient-to-br from-capsule-midnight via-capsule-sealed to-capsule-midnight border-2 border-accent/40 shadow-xl">

        {/* Inner glow */}

        <div className="absolute inset-2 rounded-full bg-gradient-to-br from-accent/10 to-transparent" />


        {/* Lock / Unlock icon */}

        <div className="absolute inset-0 flex items-center justify-center">

          {isLocked ? (

            <svg
              aria-hidden="true"
              className="w-1/3 h-1/3 text-accent"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >

              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
              />

            </svg>

          ) : (

            <svg
              aria-hidden="true"
              className="w-1/3 h-1/3 text-capsule-unlocked"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >

              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M8 11V7a4 4 0 118 0m-4 8v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2z"
              />

            </svg>

          )}

        </div>

      </div>


      {/* Glow effect */}

      <motion.div
        className="absolute inset-0 rounded-full bg-accent/20 blur-xl -z-10"
        animate={
          shouldAnimate
            ? { opacity: [0.3, 0.6, 0.3] }
            : false
        }
        transition={{
          duration: 3,
          repeat: Infinity,
          ease: "easeInOut",
        }}
      />

    </motion.div>

  );

};