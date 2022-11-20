import { $window, rgb2arr } from '@antv/l7-utils';
import { EventEmitter } from 'eventemitter3';
import { inject, injectable } from 'inversify';
import { throttle } from 'lodash';
import 'reflect-metadata';
import { TYPES } from '../../types';
import Clock from '../../utils/clock';
import { IMapService } from '../map/IMapService';
import { IRendererService } from '../renderer/IRendererService';
import { ILayer, ILayerService, LayerServiceEvent } from './ILayerService';

@injectable()
export default class LayerService extends EventEmitter<LayerServiceEvent>
  implements ILayerService {
  // pickedLayerId 参数用于指定当前存在被选中的 layer
  public pickedLayerId: number = -1;
  public clock = new Clock();

  public alreadyInRendering: boolean = false;

  private layers: ILayer[] = [];

  private layerList: ILayer[] = [];

  private layerRenderID: number;

  private sceneInited: boolean = false;

  private animateInstanceCount: number = 0;

  // TODO: 是否开启 shader 中的颜色拾取计算
  private shaderPicking: boolean = true;

  private enableRender: boolean = true;

  @inject(TYPES.IRendererService)
  private readonly renderService: IRendererService;

  @inject(TYPES.IMapService)
  private readonly mapService: IMapService;

  public reRender = throttle(() => {
    this.updateLayerRenderList();
    this.renderLayers();
  }, 32);

  public throttleRenderLayers = throttle(() => {
    this.renderLayers();
  }, 16);

  public needPick(type:string): boolean {
   return this.layerList.some((layer=>layer.needPick(type)))
  }
  public add(layer: ILayer) {
    this.layers.push(layer);
    if (this.sceneInited) {
      layer.init().then(() => {
        this.updateLayerRenderList();
        this.renderLayers();
      });
    } 
   
  
  }

  public addMask(mask: ILayer) {
    if (this.sceneInited) {
      mask.init().then(() => {
        this.renderLayers();
      });
    }
  }

  public async initLayers() {
    this.sceneInited = true;

    this.layers.forEach(async (layer) => {
      if (!layer.startInit) {
        await layer.init();
        this.updateLayerRenderList();
      }
    });
  }

  public getSceneInited() {
    return this.sceneInited;
  }

  public getRenderList(): ILayer[] {
    return this.layerList;
  }

  public getLayers(): ILayer[] {
    return this.layers;
  }

  public getLayer(id: string): ILayer | undefined {
    return this.layers.find((layer) => layer.id === id);
  }

  public getLayerByName(name: string): ILayer | undefined {
    return this.layers.find((layer) => layer.name === name);
  }

  public remove(layer: ILayer, parentLayer?: ILayer): void {
    // Tip: layer.layerChildren 当 layer 存在子图层的情况
    if (parentLayer) {
      const layerIndex = parentLayer.layerChildren.indexOf(layer);
      if (layerIndex > -1) {
        parentLayer.layerChildren.splice(layerIndex, 1);
      }
    } else {
      const layerIndex = this.layers.indexOf(layer);
      if (layerIndex > -1) {
        this.layers.splice(layerIndex, 1);
      }
    }
    this.updateLayerRenderList();
    layer.destroy();
    this.renderLayers();
    this.emit('layerChange', this.layers);
  }

  public removeAllLayers() {
    this.destroy();
    this.renderLayers();
  }

  public setEnableRender(flag: boolean) {
    this.enableRender = flag;
  }

  public async renderLayers() {
    if (this.alreadyInRendering || !this.enableRender) {
      return;
    }
    this.alreadyInRendering = true;
    this.clear();
    for (const layer of this.layerList) {
      if (layer.masks.filter((m)=>m.inited).length > 0) {
        // 清除上一次的模版缓存
        this.renderService.clear({
          stencil: 0,
          depth: 1,
          framebuffer: null,
        });
        layer.masks.map(async (m: ILayer) => {
          m.render();
        })
      }

      if (layer.getLayerConfig().enableMultiPassRenderer) {
        // multiPassRender 不是同步渲染完成的
        await layer.renderMultiPass();
      } else {
        await layer.render();
   
      }
    }
    this.alreadyInRendering = false;
  }
  
  public renderMask(masks:ILayer[]) {
    masks.filter(m => m.inited)
    .map(m =>{
      m.render();
    })
  }

  public async beforeRenderData(layer: ILayer) {
    const flag = await layer.hooks.beforeRenderData.promise();
    if(flag) {
      this.renderLayers();
    }
    
  }

  async renderLayer(layer: ILayer){

    if (layer.masks.filter((m)=>m.inited).length > 0) {
      layer.masks.map(mask =>{
          this.renderService.clear({
            stencil: 0,
            depth: 1,
            framebuffer: null,
          });
          mask.render();  
      })

    }
    if (layer.getLayerConfig().enableMultiPassRenderer) {
      // multiPassRender 不是同步渲染完成的
      await layer.renderMultiPass();
    } else {
      await layer.render();
    }

  }

  public updateLayerRenderList() {
    // Tip: 每次更新都是从 layers 重新构建
    this.layerList = [];
    this.layers
      .filter((layer) => layer.inited)
      .filter((layer) => layer.isVisible())
      .sort((pre: ILayer, next: ILayer) => {
        // 根据 zIndex 对渲染顺序进行排序
        return pre.zIndex - next.zIndex;
      })
      .forEach((layer) => {
        this.layerList.push(layer);
      });

  }

  public destroy() {
    this.layers.forEach((layer) => {
      layer.destroy();
    });
    this.layers = [];
    this.layerList = [];
    this.emit('layerChange', this.layers);
  }

  public startAnimate() {
    if (this.animateInstanceCount++ === 0) {
      this.clock.start();
      this.runRender();
    }
  }

  public stopAnimate() {
    if (--this.animateInstanceCount === 0) {
      this.stopRender();
      this.clock.stop();
    }
  }

  public getOESTextureFloat() {
    return this.renderService.extensionObject.OES_texture_float;
  }

  // 控制着色器颜色拾取计算
  public enableShaderPick() {
    this.shaderPicking = true;
  }

  public disableShaderPick() {
    this.shaderPicking = false;
  }

  public getShaderPickStat() {
    return this.shaderPicking;
  }
  

  public clear() {
    const color = rgb2arr(this.mapService.bgColor) as [
      number,
      number,
      number,
      number,
    ];
    this.renderService.clear({
      color,
      depth: 1,
      stencil: 0,
      framebuffer: null,
    });
  }

  private runRender() {
    this.renderLayers();
    this.layerRenderID = $window.requestAnimationFrame(
      this.runRender.bind(this),
    );
  }

  private stopRender() {
    $window.cancelAnimationFrame(this.layerRenderID);
  }


}
