const atlas = new Image();
atlas.src = "/public/chess-pieces.png";
const ASS = 240; // Atlas Sprite Size

type PieceType = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11;
type Position = [ number, number ];
type PieceAnimation = [PieceType , Position, Position | null];

export default class CanvasChessRenderer {
	canvas: HTMLCanvasElement;
	ctx: CanvasRenderingContext2D;
	pieceAnimations: PieceAnimation[] = [];
	animationBegin: number;
	ANIMATION_LENGTH = 500;
	animationRequest: number | null = null;

	constructor(canvas: HTMLCanvasElement) {
		this.canvas = canvas;
		this.ctx = this.canvas.getContext('2d')!;
		this.resize();

		const resizeObserver = new ResizeObserver(() => this.resize());
		resizeObserver.observe(canvas);
	}

	resize() {
		if (this.canvas.clientWidth === 0) { // Why is that needed?
			console.log("refusing resize")
			return;
		}
		this.canvas.width = this.canvas.clientWidth * window.devicePixelRatio;
		this.canvas.height = this.canvas.clientHeight * window.devicePixelRatio;
		this.#moarAnimationNeeded();
	}

	setPosition(fen: string) {
		let idx = 0;
		const newPieces: [PieceType, Position][] = [];
		for(const c of fen.split(' ')[0]) {
			if(c === '/') { continue; }
			if(c === '1') { idx += 1; continue; }
			if(c === '2') { idx += 2; continue; }
			if(c === '3') { idx += 3; continue; }
			if(c === '4') { idx += 4; continue; }
			if(c === '5') { idx += 5; continue; }
			if(c === '6') { idx += 6; continue; }
			if(c === '7') { idx += 7; continue; }
			if(c === '8') { idx += 8; continue; }
			const pt = {p:0,P:1,n:2,N:3,b:4,B:5,r:6,R:7,q:8,Q:9,k:10,K:11}[c];
			newPieces.push([pt, [Math.floor(idx / 8), idx % 8]]);
			idx += 1;
		}

		// Match newPieces with this.pieces so that we know what moved where and animate
		// properly.
		const newPieceAnimations: PieceAnimation[] = [];

		// 0. Remove piece animations that are already done.
		this.pieceAnimations = this.pieceAnimations.filter(([, , currPos]) => currPos != null);

		// 1. Match new pieces that didn't move at all.
		for(let i = 0;i < newPieces.length;i ++) {
			for(let j = 0;j < this.pieceAnimations.length;j ++) {
				if (newPieces[i][0] !== this.pieceAnimations[j][0]) continue;
				if (newPieces[i][1][0] !== this.pieceAnimations[j][2]![0]) continue;
				if (newPieces[i][1][1] !== this.pieceAnimations[j][2]![1]) continue;
				
				// Matched i and j, yey!
				newPieceAnimations.push([newPieces[i][0], newPieces[i][1], newPieces[i][1]]);
				newPieces.splice(i, 1);
				this.pieceAnimations.splice(j, 1);
				i --;
				break;
			}
		}

		// 2. Match new pieces that moved.
		for(let i = 0;i < newPieces.length;i ++) {
			for(let j = 0;j < this.pieceAnimations.length;j ++) {
				if (newPieces[i][0] !== this.pieceAnimations[j][0]) continue;
				
				// Matched i and j, yey!
				newPieceAnimations.push([newPieces[i][0], this.pieceAnimations[j][2]!, newPieces[i][1]]);
				newPieces.splice(i, 1);
				this.pieceAnimations.splice(j, 1);
				i --;
				break;
			}
		}

		// 3. Make brand new pieces appear.
		for (const np of newPieces) {
			newPieceAnimations.push([np[0], null, np[1]]);
		}

		// 4. Make old pieces disappear.
		for(const pa of this.pieceAnimations) {
			newPieceAnimations.push([pa[0], pa[2]!, null]);
		}

		this.animationBegin = Date.now();
		this.pieceAnimations = newPieceAnimations;

		this.#moarAnimationNeeded();
	}

	#moarAnimationNeeded() {
		if (this.animationRequest != null) return; // Already animation requested.
		this.animationRequest = window.requestAnimationFrame(() => this.#draw());
	}

	#draw() {
		const drawSize = this.canvas.width / 8;

		let T = (Date.now() - this.animationBegin) / this.ANIMATION_LENGTH;
		if (T > 1) T = 1;
		// https://math.stackexchange.com/questions/121720/ease-in-out-function/121755#121755
		const animT = Math.pow(T, 3) / (Math.pow(T, 3) + Math.pow(1-T, 3));

		// Draw the background checkerboard pattern.
		this.ctx.fillStyle = '#b18a66';
		this.ctx.globalAlpha = 1;
		this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
		this.ctx.fillStyle = '#eedab8';
		for(let row = 0;row < 8; row ++) {
			for(let col = 0;col < 8; col ++) {
				if(row % 2 === col % 2) continue;
				this.ctx.fillRect(col * drawSize, row * drawSize, drawSize, drawSize);
			}
		}

		for(const [pt, lastPos, currPos] of this.pieceAnimations) {
			let dx = 0, dy = 0;
			if (currPos == null) {
				// Animate by fading out.
				this.ctx.globalAlpha = 1 - animT;
				dy = lastPos[0];
				dx = lastPos[1];
			} else if (lastPos == null) {
				// Animate by fading in.
				this.ctx.globalAlpha = animT;
				dy = currPos[0];
				dx = currPos[1];
			} else {
				// Animate by moving the piece.
				this.ctx.globalAlpha = 1;
				dy = lastPos[0] + (currPos[0] - lastPos[0]) * animT;
				dx = lastPos[1] + (currPos[1] - lastPos[1]) * animT;
			}

			const cutX = Math.floor(pt / 2);
			const cutY = pt % 2; // White pieces are on the top row of the atlas.

			this.ctx.drawImage(atlas, cutX * ASS, cutY * ASS, ASS, ASS, dx * drawSize, dy * drawSize, drawSize, drawSize);
		}

		this.animationRequest = null;
		if (T < 1) this.#moarAnimationNeeded();
	}
};
