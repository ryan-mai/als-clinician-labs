"use strict";
// MRI images for the case file (synthetic / illustrative). Shown as a stack of cards on the Doctor report and printed as figures in the report.
// Captions are the radiology-style findings for each image; they are also sent to Gemini so the written summary can mention imaging.
(function (root) {
  const SETS = {
    "ALEX-CASE": [
      { id: "flair", tab: "Brain FLAIR", src: "assets/mri/flair.png", alt: "Axial brain MRI, FLAIR sequence, with arrows on both sides of the internal capsule",
        title: "Brain, axial FLAIR at the level of the internal capsule",
        finding: "Symmetric hyperintensity along the posterior limb of the internal capsule on both sides (arrows), following the corticospinal tracts." },
      { id: "swi", tab: "Brain SWI", src: "assets/mri/swi.png", alt: "Axial brain MRI, susceptibility-weighted, near the vertex, with arrows on the precentral gyri",
        title: "Brain, axial susceptibility-weighted near the vertex",
        finding: "A thin band of low signal along the precentral gyrus on both sides (arrows), sometimes called the motor band sign." },
      { id: "spine", tab: "Cervical spine", src: "assets/mri/spine.png", alt: "Sagittal T2 MRI of the cervical spine",
        title: "Cervical spine, sagittal T2",
        finding: "Normal alignment. No disc protrusion, canal stenosis, cord compression or intrinsic cord signal change from the foramen magnum to T2." }
    ]
  };
  root.MRI = { forPatient: code => (SETS[code] || []).map((m, i) => ({ ...m, n: i + 1, label: String.fromCharCode(65 + i) })) };
})(typeof window !== "undefined" ? window : globalThis);
