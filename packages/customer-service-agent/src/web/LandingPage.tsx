import { useEffect, useRef, useState } from "react";
import "./landing.css";

interface LandingPageProps {
	loading: boolean;
	error: string;
	onEnter: () => void;
}

type Scene = "distant" | "approach" | "arrival";

function smoothstep(start: number, end: number, value: number): number {
	const position = Math.max(0, Math.min(1, (value - start) / (end - start)));
	return position * position * (3 - 2 * position);
}

function drawPlanet(canvas: HTMLCanvasElement): void {
	const context = canvas.getContext("2d");
	if (!context) return;
	const { width, height } = canvas;
	const pixels = context.createImageData(width, height);
	const radius = width * 0.46;
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const nx = (x - width / 2) / radius;
			const ny = (y - height / 2) / radius;
			const distance = nx * nx + ny * ny;
			if (distance >= 1) continue;
			const depth = Math.sqrt(1 - distance);
			const latitude = ny * 15 + Math.sin(nx * 4 + ny * 2) * 1.25 + Math.sin(nx * 8 - ny * 3) * 0.4;
			const band = (Math.sin(latitude) + 1) / 2;
			const cloud = Math.max(0, Math.sin(latitude * 1.8 + Math.sin(nx * 6) * 0.5)) ** 3;
			const warmth = Math.exp(-((nx + 0.42) ** 2 + (ny + 0.35) ** 2) * 7);
			const light = Math.max(0.08, -nx * 0.42 - ny * 0.4 + depth * 0.7);
			const shade = (0.18 + light * 0.95) * (0.55 + depth * 0.45);
			const index = (y * width + x) * 4;
			pixels.data[index] = Math.min(255, (34 + band * 38 + cloud * 18 + warmth * 100) * shade);
			pixels.data[index + 1] = Math.min(255, (70 + band * 54 + cloud * 22 + warmth * 72) * shade);
			pixels.data[index + 2] = Math.min(255, (91 + band * 58 + cloud * 24 + warmth * 37) * shade);
			pixels.data[index + 3] = Math.round(Math.min(1, (1 - distance) * 85) * 255);
		}
	}
	context.putImageData(pixels, 0, 0);
}

export function LandingPage({ loading, error, onEnter }: LandingPageProps) {
	const scrollRef = useRef<HTMLElement>(null);
	const stageRef = useRef<HTMLDivElement>(null);
	const entryButtonRef = useRef<HTMLButtonElement>(null);
	const planetCanvasRef = useRef<HTMLCanvasElement>(null);
	const focusAfterSkipRef = useRef(false);
	const [scene, setScene] = useState<Scene>("distant");
	const [arrived, setArrived] = useState(false);
	const [reducedMotion, setReducedMotion] = useState(false);

	useEffect(() => {
		if (planetCanvasRef.current) drawPlanet(planetCanvasRef.current);
	}, []);

	useEffect(() => {
		if (arrived && focusAfterSkipRef.current) {
			entryButtonRef.current?.focus({ preventScroll: true });
			focusAfterSkipRef.current = false;
		}
	}, [arrived]);

	useEffect(() => {
		const scroller = scrollRef.current;
		const stage = stageRef.current;
		if (!scroller || !stage) return;
		const media = window.matchMedia("(prefers-reduced-motion: reduce)");
		let frame = 0;

		const render = () => {
			frame = 0;
			const maxScroll = scroller.scrollHeight - scroller.clientHeight;
			const progress = media.matches ? 1 : maxScroll > 0 ? scroller.scrollTop / maxScroll : 0;
			const approach = smoothstep(0.08, 0.66, progress);
			const flyby = smoothstep(0.59, 0.88, progress);
			const arrival = smoothstep(0.76, 0.96, progress);
			const distantOpacity = 1 - smoothstep(0.14, 0.36, progress);
			const approachOpacity = smoothstep(0.26, 0.43, progress) * (1 - smoothstep(0.64, 0.79, progress));
			const firstMeteor = smoothstep(0.09, 0.17, progress) * (1 - smoothstep(0.31, 0.39, progress));
			const secondMeteor = smoothstep(0.39, 0.47, progress) * (1 - smoothstep(0.59, 0.68, progress));
			const width = stage.clientWidth;
			const height = stage.clientHeight;

			stage.style.setProperty("--planet-scale", String(0.68 + approach * 2.55 + flyby * 3.45));
			stage.style.setProperty("--planet-x", `${(-approach * 0.13 - flyby * 0.38) * width}px`);
			stage.style.setProperty("--planet-y", `${(approach * 0.07 + flyby * 0.2) * height}px`);
			stage.style.setProperty("--planet-opacity", String(1 - smoothstep(0.79, 0.94, progress)));
			stage.style.setProperty("--star-near-x", `${-progress * width * 0.24}px`);
			stage.style.setProperty("--star-near-y", `${progress * height * 0.18}px`);
			stage.style.setProperty("--star-far-x", `${progress * width * 0.09}px`);
			stage.style.setProperty("--orbit-scale", String(0.82 + approach * 1.5));
			stage.style.setProperty("--orbit-opacity", String(1 - flyby));
			stage.style.setProperty("--distant-opacity", String(distantOpacity));
			stage.style.setProperty("--approach-opacity", String(approachOpacity));
			stage.style.setProperty("--arrival-opacity", String(arrival));
			stage.style.setProperty("--horizon-opacity", String(arrival));
			stage.style.setProperty("--meteor-one-opacity", String(firstMeteor));
			stage.style.setProperty("--meteor-one-x", `${(-0.18 + progress * 2.7) * width}px`);
			stage.style.setProperty("--meteor-one-y", `${(0.2 + progress * 0.72) * height}px`);
			stage.style.setProperty("--meteor-two-opacity", String(secondMeteor));
			stage.style.setProperty("--meteor-two-x", `${(-0.38 + progress * 2.08) * width}px`);
			stage.style.setProperty("--meteor-two-y", `${(0.05 + progress * 0.94) * height}px`);
			stage.style.setProperty("--progress", String(progress));

			setScene(progress < 0.34 ? "distant" : progress < 0.77 ? "approach" : "arrival");
			setArrived(progress >= 0.82);
		};
		const scheduleRender = () => {
			if (!frame) frame = window.requestAnimationFrame(render);
		};
		const handleMotionChange = () => {
			setReducedMotion(media.matches);
			scheduleRender();
		};

		setReducedMotion(media.matches);
		render();
		scroller.addEventListener("scroll", scheduleRender, { passive: true });
		window.addEventListener("resize", scheduleRender);
		media.addEventListener("change", handleMotionChange);
		return () => {
			if (frame) window.cancelAnimationFrame(frame);
			scroller.removeEventListener("scroll", scheduleRender);
			window.removeEventListener("resize", scheduleRender);
			media.removeEventListener("change", handleMotionChange);
		};
	}, []);

	function goTo(progress: number): void {
		const scroller = scrollRef.current;
		if (!scroller) return;
		focusAfterSkipRef.current = progress === 1;
		scroller.scrollTo({ top: progress * (scroller.scrollHeight - scroller.clientHeight), behavior: "auto" });
	}

	return (
		<main className="landing-page" ref={scrollRef}>
			<div className="journey-track">
				<div className="journey-stage" ref={stageRef} data-scene={scene}>
					<div className="journey-space" aria-hidden="true">
						<div className="journey-nebula" />
						<div className="journey-stars journey-stars--far" />
						<div className="journey-stars journey-stars--near" />
						<div className="journey-orbit journey-orbit--outer" />
						<div className="journey-orbit journey-orbit--inner" />
						<div className="journey-planet">
							<canvas ref={planetCanvasRef} className="journey-planet__image" width={512} height={512} />
						</div>
						<div className="journey-meteor journey-meteor--one" />
						<div className="journey-meteor journey-meteor--two" />
						<div className="journey-horizon" />
					</div>

					<header className="journey-header">
						<div className="journey-brand" aria-label="衡木客服台"><span aria-hidden="true">✳</span> 衡木 <small>/ SERVICE</small></div>
						<button type="button" className="journey-skip" onClick={() => goTo(arrived ? 0 : 1)}>
						{arrived ? "返回起点" : "跳过动画，前往入口"} <span aria-hidden="true">↗</span>
						</button>
					</header>

					<section className="journey-copy journey-copy--distant" aria-labelledby="journey-title" aria-hidden={scene !== "distant"}>
						<p className="journey-eyebrow"><span>01 / 03</span> 从一条咨询出发</p>
						<h1 id="journey-title">每个问题，<br /><em>都值得被看见。</em></h1>
						<p>向下滚动，靠近答案。库存、订单和售后，都可以从这里开始。</p>
					</section>

					<section className="journey-copy journey-copy--approach" aria-labelledby="approach-title" aria-hidden={scene !== "approach"}>
						<p className="journey-eyebrow"><span>02 / 03</span> 正在接近</p>
						<h2 id="approach-title">答案，<br /><em>就在前方。</em></h2>
						<p>实时查询交给工具；需要判断和处理的事，交给人工客服。</p>
						<div className="journey-service-tags"><span>库存查询</span><span>订单协助</span><span>售后跟进</span></div>
					</section>

					<section className="journey-arrival" aria-labelledby="arrival-title" aria-hidden={!arrived}>
						<div className="journey-arrival__marker"><span aria-hidden="true" /> 服务站已抵达 <span>03 / 03</span></div>
						<div className="journey-arrival__window">
							<p className="journey-arrival__status"><span aria-hidden="true" /> CUSTOMER SUPPORT / ONLINE</p>
							<h2 id="arrival-title">现在，<br />开始对话。</h2>
							<p>无需账号即可体验。进入后会恢复你的最近会话；订单与退款操作仍需你确认。</p>
							<button ref={entryButtonRef} type="button" className="journey-enter" disabled={!arrived || loading} onClick={onEnter}>
								<span>{loading ? "正在连接客服…" : "进入演示客服"}</span><span aria-hidden="true">↗</span>
							</button>
							{error && <p className="journey-arrival__error" role="alert">连接失败：{error}。请检查服务状态后重试。</p>}
						</div>
					</section>

					<div className="journey-index" aria-hidden="true"><span>远望</span><span>接近</span><span>抵达</span><i /></div>
					{!arrived && !reducedMotion && (
						<button type="button" className="journey-scroll-cue" onClick={() => goTo(scene === "distant" ? 0.42 : 1)}>
							<span>向下滚动，继续旅程</span><span aria-hidden="true">↓</span>
						</button>
					)}
					<footer className="journey-footer"><span>每一次咨询，都有迹可循</span><span>PI AGENT · 演示环境</span></footer>
				</div>
			</div>
		</main>
	);
}
