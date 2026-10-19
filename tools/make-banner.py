# Generates assets/banner.png (1280x720, Telegram description picture needs 640x360 -> banner-640.png also written)
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import random, math
W,H,S=1280,720,2
w,h=W*S,H*S
img=Image.new("RGB",(w,h),(8,11,15))
px=img.load()
# vertical gradient + warm vignette
for y in range(h):
    t=y/h
    r=int(9+14*t); g=int(12+10*t); b=int(17+4*t)
    for x in range(0,w):
        px[x,y]=(r,g,b)
glow=Image.new("RGB",(w,h),(0,0,0))
gd=ImageDraw.Draw(glow)
gd.ellipse((w*0.52,h*0.05,w*1.1,h*0.95),fill=(120,88,20))
gd.ellipse((-w*0.1,h*0.55,w*0.35,h*1.2),fill=(20,70,50))
glow=glow.filter(ImageFilter.GaussianBlur(220*S/2))
img=Image.blend(img,Image.composite(glow,img,glow.convert("L")),0.0)
from PIL import ImageChops
img=ImageChops.add(img,glow.point(lambda v:int(v*0.55)))
d=ImageDraw.Draw(img,"RGBA")
# grid
for i in range(0,W,80):
    d.line((i*S,0,i*S,h),fill=(255,255,255,10),width=S)
for j in range(0,H,80):
    d.line((0,j*S,w,j*S),fill=(255,255,255,10),width=S)
# candles (right half)
random.seed(11)
x0,x1=640,1230; n=17; step=(x1-x0)/n
price=560; pts=[]
for i in range(n):
    o=price; c=o-random.uniform(-26,58) if i>2 else o-random.uniform(-10,30)
    c=min(c,o+20) if random.random()<.25 else c
    hi=min(o,c)-random.uniform(8,34); lo=max(o,c)+random.uniform(8,30)
    up=c<o
    col=(52,211,153,255) if up else (239,87,87,255)
    cx=(x0+step*i+step/2)*S
    d.line((cx,hi*S,cx,lo*S),fill=col,width=3*S)
    bw=step*0.56*S
    d.rounded_rectangle((cx-bw/2,min(o,c)*S,cx+bw/2,max(o,c)*S+2*S),radius=3*S,fill=col)
    pts.append((cx,(o+c)/2*S)); price=c-6
# gold trend line
d.line([(p[0],p[1]-70*S) for p in pts],fill=(224,184,74,230),width=5*S,joint="curve")
# ring emblem
cx,cy,R=1010*S,200*S,95*S
for k,a in ((0,60),(8,35),(16,18)):
    d.ellipse((cx-R-k*S,cy-R-k*S,cx+R+k*S,cy+R+k*S),outline=(224,184,74,a),width=2*S)
d.ellipse((cx-R,cy-R,cx+R,cy+R),outline=(224,184,74,255),width=5*S)
for i,(bh,col) in enumerate(((40,(224,184,74)),(70,(52,211,153)),(100,(224,184,74)))):
    bx=cx-45*S+i*34*S
    d.rounded_rectangle((bx,cy+40*S-bh*S,bx+24*S,cy+40*S),radius=5*S,fill=col+(255,))
d.line((cx-60*S,cy-8*S,cx-14*S,cy-40*S,cx+16*S,cy-14*S,cx+58*S,cy-58*S),fill=(255,255,255,235),width=5*S,joint="curve")
# text
def F(sz,bold=True):
    return ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans%s.ttf"%("-Bold" if bold else ""),sz*S)
d.text((70*S,150*S),"YETIMMM",font=F(112),fill=(236,196,84,255))
d.rectangle((74*S,290*S,74*S+150*S,294*S),fill=(224,184,74,255))
d.text((74*S,318*S),"XAUUSD  ·  Smart Risk Sequence",font=F(36,False),fill=(235,238,242,255))
d.text((74*S,372*S),"Automated Buy / Sell Stop cycles for MT5",font=F(26,False),fill=(150,160,175,255))
# chips
x=74
for label in ("MT5","Live Monitoring","Telegram Mini App"):
    f=F(24); tw=d.textlength(label,font=f)/S
    d.rounded_rectangle((x*S,560*S,(x+tw+44)*S,614*S),radius=27*S,fill=(255,255,255,14),outline=(224,184,74,160),width=2*S)
    d.text(((x+22)*S,572*S),label,font=f,fill=(236,196,84,255))
    x+=tw+44+16
img=img.resize((W,H),Image.LANCZOS)
img.save("assets/banner.png",optimize=True)
img.resize((640,360),Image.LANCZOS).save("assets/banner-640.png",optimize=True)
