import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { DeskApp } from "./DeskApp.tsx";
import "./desk.css";

const root = document.getElementById("root");
if (!root) throw new Error("Root element was not found");

createRoot(root).render(
	<StrictMode>
		<DeskApp />
	</StrictMode>,
);
