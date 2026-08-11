import {
  useLocation,
  useNavigate
} from "react-router-dom";

import { ArrowLeft } from "lucide-react";


export function BackButton() {

  const location =
    useLocation();

  const navigate =
    useNavigate();


  /**
   * Pages that should NOT show the global back button
   */

  const hiddenPaths = [

    "/",

    "/create",

    "/capsule/preview",

  ];


  const isCapsuleView =

    location.pathname.startsWith(
      "/capsule/"
    ) &&

    location.pathname !==
      "/capsule/preview";


  const isConfirmView =

    location.pathname.startsWith(
      "/confirm/"
    );


  if (

    hiddenPaths.includes(
      location.pathname
    ) ||

    isCapsuleView ||

    isConfirmView

  ) {

    return null;

  }


  function handleBack() {

    if (window.history.length > 1) {

      navigate(-1);

    }

    else {

      navigate("/");

    }

  }


  return (

    <button

      onClick={handleBack}

      className="back-button"

      aria-label="Go back"

      type="button"

    >

      <ArrowLeft />

      <span>Back</span>

    </button>

  );

}