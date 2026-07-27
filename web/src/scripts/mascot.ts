// Abstract PC-98 Micro-Terminal & User Mascot Renderers (48x48 pixel canvas)

export class PC98MascotRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private animFrame: number = 0;
  private tick: number = 0;

  constructor(canvasElement: HTMLCanvasElement) {
    this.canvas = canvasElement;
    this.canvas.width = 48;
    this.canvas.height = 48;
    const context = this.canvas.getContext('2d');
    if (!context) throw new Error('Could not get 2d context for mascot canvas');
    this.ctx = context;
    this.ctx.imageSmoothingEnabled = false;
    this.startAnimation();
  }

  public startAnimation() {
    if (typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      this.drawMascot();
      return;
    }
    const render = () => {
      this.tick++;
      this.drawMascot();
      this.animFrame = requestAnimationFrame(render);
    };
    render();
  }

  public stopAnimation() {
    cancelAnimationFrame(this.animFrame);
  }

  private drawMascot() {
    const { ctx } = this;
    ctx.clearRect(0, 0, 48, 48);

    const floatY = Math.sin(this.tick * 0.08) * 1.5;

    const voidBlack = '#0A0A14';
    const indigo = '#22224A';
    const slate = '#333C57';
    const paleGrey = '#C0CBDC';
    const boneWhite = '#F2F0E5';
    const cyan = '#73EFF7';
    const green = '#38B764';
    const pink = '#E5537A';
    const amber = '#F4B41B';

    ctx.fillStyle = voidBlack;
    ctx.fillRect(12, 42, 24, 2);

    const bx = 8;
    const by = Math.round(10 + floatY);

    ctx.fillStyle = slate;
    ctx.fillRect(bx, by, 32, 24);

    ctx.fillStyle = boneWhite;
    ctx.fillRect(bx, by, 32, 2);
    ctx.fillRect(bx, by, 2, 24);

    ctx.fillStyle = voidBlack;
    ctx.fillRect(bx, by + 22, 32, 2);
    ctx.fillRect(bx + 30, by, 2, 24);

    ctx.fillStyle = voidBlack;
    ctx.fillRect(bx + 4, by + 4, 24, 14);

    ctx.fillStyle = indigo;
    ctx.fillRect(bx + 5, by + 5, 22, 12);

    const isBlinking = (Math.floor(this.tick / 30) % 8 === 0) && (this.tick % 10 < 3);

    ctx.fillStyle = cyan;
    if (isBlinking) {
      ctx.fillRect(bx + 9, by + 10, 4, 1);
      ctx.fillRect(bx + 19, by + 10, 4, 1);
    } else {
      ctx.fillRect(bx + 9, by + 9, 3, 3);
      ctx.fillRect(bx + 20, by + 9, 3, 3);
      ctx.fillStyle = boneWhite;
      ctx.fillRect(bx + 10, by + 9, 1, 1);
      ctx.fillRect(bx + 21, by + 9, 1, 1);
    }

    ctx.fillStyle = green;
    const mouthStep = Math.floor(this.tick / 12) % 3;
    if (mouthStep === 0) {
      ctx.fillRect(bx + 13, by + 14, 6, 1);
    } else if (mouthStep === 1) {
      ctx.fillRect(bx + 12, by + 14, 2, 1);
      ctx.fillRect(bx + 14, by + 13, 4, 1);
      ctx.fillRect(bx + 18, by + 14, 2, 1);
    } else {
      ctx.fillRect(bx + 13, by + 13, 6, 1);
    }

    ctx.fillStyle = paleGrey;
    ctx.fillRect(bx + 15, by - 5, 2, 5);

    const ledColor = (Math.floor(this.tick / 20) % 2 === 0) ? amber : pink;
    ctx.fillStyle = ledColor;
    ctx.fillRect(bx + 14, by - 8, 4, 3);

    ctx.fillStyle = voidBlack;
    ctx.fillRect(bx + 6, by + 19, 10, 2);
    ctx.fillStyle = green;
    ctx.fillRect(bx + 24, by + 19, 2, 2);
  }
}

// Custom 48x48 Animated PC-98 User Avatar Renderer
export type UserAvatarPreset = 'cyber_pilot' | 'hacker' | 'mecha' | 'master';

export class PC98UserMascotRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private animFrame: number = 0;
  private tick: number = 0;
  public preset: UserAvatarPreset;
  public accentColor: string;

  constructor(canvasElement: HTMLCanvasElement, preset: UserAvatarPreset = 'cyber_pilot', accentColor: string = '#41A6F6') {
    this.canvas = canvasElement;
    this.canvas.width = 48;
    this.canvas.height = 48;
    const context = this.canvas.getContext('2d');
    if (!context) throw new Error('Could not get 2d context for user avatar canvas');
    this.ctx = context;
    this.ctx.imageSmoothingEnabled = false;
    this.preset = preset;
    this.accentColor = accentColor;
    this.startAnimation();
  }

  public startAnimation() {
    if (typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      this.drawAvatar();
      return;
    }
    const render = () => {
      this.tick++;
      this.drawAvatar();
      this.animFrame = requestAnimationFrame(render);
    };
    render();
  }

  public stopAnimation() {
    cancelAnimationFrame(this.animFrame);
  }

  private drawAvatar() {
    const { ctx } = this;
    ctx.clearRect(0, 0, 48, 48);

    const floatY = Math.sin(this.tick * 0.09) * 1.2;

    const voidBlack = '#0A0A14';
    const indigo = '#22224A';
    const slate = '#333C57';
    const paleGrey = '#C0CBDC';
    const boneWhite = '#F2F0E5';
    const tan = '#E4A672';
    const pink = '#E5537A';
    const amber = '#F4B41B';
    const green = '#38B764';

    // Background Frame Well
    ctx.fillStyle = voidBlack;
    ctx.fillRect(0, 0, 48, 48);

    const bx = 4;
    const by = Math.round(4 + floatY);

    if (this.preset === 'cyber_pilot') {
      // Anime Hair (Blue/Black Spiky 90s Hair)
      ctx.fillStyle = indigo;
      ctx.fillRect(bx + 8, by + 2, 24, 10);
      ctx.fillRect(bx + 4, by + 6, 8, 12);
      ctx.fillRect(bx + 28, by + 6, 8, 12);

      // Face Base
      ctx.fillStyle = tan;
      ctx.fillRect(bx + 10, by + 10, 20, 18);

      // Glowing Cyber Visor (Animated Scanline)
      ctx.fillStyle = this.accentColor;
      ctx.fillRect(bx + 8, by + 12, 24, 6);
      ctx.fillStyle = boneWhite;
      const scanX = Math.floor(this.tick / 3) % 20;
      ctx.fillRect(bx + 9 + scanX, by + 13, 4, 4);

      // Headset Microphone
      ctx.fillStyle = pink;
      ctx.fillRect(bx + 4, by + 14, 4, 10);
      ctx.fillStyle = amber;
      ctx.fillRect(bx + 6, by + 22, 10, 2);

      // Mouth Line
      ctx.fillStyle = voidBlack;
      ctx.fillRect(bx + 16, by + 24, 8, 2);

    } else if (this.preset === 'hacker') {
      // Hoodie Body
      ctx.fillStyle = slate;
      ctx.fillRect(bx + 4, by + 4, 32, 32);
      ctx.fillStyle = voidBlack;
      ctx.fillRect(bx + 8, by + 8, 24, 24);

      // Face
      ctx.fillStyle = tan;
      ctx.fillRect(bx + 12, by + 12, 16, 14);

      // Dark Matrix Sunglasses
      ctx.fillStyle = voidBlack;
      ctx.fillRect(bx + 10, by + 14, 20, 6);
      ctx.fillStyle = this.accentColor;
      const particleY = Math.floor(this.tick / 6) % 4;
      ctx.fillRect(bx + 12, by + 15 + particleY, 6, 1);
      ctx.fillRect(bx + 22, by + 15 + particleY, 6, 1);

      // Floating Code Particles around head
      ctx.fillStyle = green;
      const p1 = (this.tick * 2) % 40;
      const p2 = (this.tick * 3) % 40;
      ctx.fillRect(2 + (p1 % 8), p1, 2, 2);
      ctx.fillRect(40 - (p2 % 8), p2, 2, 2);

    } else if (this.preset === 'mecha') {
      // Mecha Helmet Frame
      ctx.fillStyle = slate;
      ctx.fillRect(bx + 6, by + 4, 28, 28);
      ctx.fillStyle = boneWhite;
      ctx.fillRect(bx + 8, by + 6, 24, 24);

      // Mecha Visor Window
      ctx.fillStyle = voidBlack;
      ctx.fillRect(bx + 10, by + 10, 20, 12);
      ctx.fillStyle = this.accentColor;
      const pulseWidth = 10 + Math.sin(this.tick * 0.15) * 6;
      ctx.fillRect(bx + 10, by + 14, Math.round(pulseWidth), 4);

      // Antenna LED Light
      ctx.fillStyle = pink;
      ctx.fillRect(bx + 18, by + 1, 4, 4);

    } else { // 'master'
      // Classic 90s Anime Hair
      ctx.fillStyle = amber;
      ctx.fillRect(bx + 6, by + 2, 28, 12);
      ctx.fillRect(bx + 4, by + 6, 6, 14);
      ctx.fillRect(bx + 30, by + 6, 6, 14);

      // Face
      ctx.fillStyle = tan;
      ctx.fillRect(bx + 8, by + 10, 24, 18);

      // Blinking PC-98 Anime Eyes
      const isBlinking = (Math.floor(this.tick / 30) % 8 === 0) && (this.tick % 10 < 3);
      ctx.fillStyle = this.accentColor;
      if (isBlinking) {
        ctx.fillRect(bx + 11, by + 15, 6, 2);
        ctx.fillRect(bx + 23, by + 15, 6, 2);
      } else {
        ctx.fillRect(bx + 11, by + 13, 6, 6);
        ctx.fillRect(bx + 23, by + 13, 6, 6);
        ctx.fillStyle = boneWhite;
        ctx.fillRect(bx + 13, by + 14, 2, 2);
        ctx.fillRect(bx + 25, by + 14, 2, 2);
      }

      // Smile
      ctx.fillStyle = voidBlack;
      ctx.fillRect(bx + 16, by + 23, 8, 2);
    }
  }
}
