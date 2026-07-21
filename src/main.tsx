import { createRoot } from "react-dom/client";

import { ShadcnApp } from "./shadcn-app";
import "./shadcn/style.css";

createRoot(document.getElementById("root")!).render(<ShadcnApp />);
