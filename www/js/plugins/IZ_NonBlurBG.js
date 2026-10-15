//=============================================================================
// IZ_NonBlurBG.js
// ----------------------------------------------------------------------------
// Copyright (c) 2017 IZ
// This software is released under the MIT License.
// http://opensource.org/licenses/mit-license.php
// ----------------------------------------------------------------------------
// Version
// 0.1.1β 2017/11/4
//=============================================================================

/*:
 * @plugindesc アイテムシーンやスキルシーンの背景（マップ画面のスナップショット）
 * にぼかし処理をかけないようにします。
 * @author いず
 *
 * @param sceneMenu
 * @desc メニューシーンの背景にぼかし処理をかけるか
 * @default false
 * @type boolean
 *
 * @param sceneItem
 * @desc アイテムシーンの背景にぼかし処理をかけるか
 * ※マップ画面からスクリプトなどで直接遷移した時だけ適用されます
 * @default false
 * @type boolean
 *
 * @param sceneSkill
 * @desc スキルシーンの背景にぼかし処理をかけるか
 * ※マップ画面からスクリプトなどで直接遷移した時だけ適用されます
 * @default false
 * @type boolean
 *
 * @param sceneEquip
 * @desc 装備シーンの背景にぼかし処理をかけるか
 * ※マップ画面からスクリプトなどで直接遷移した時だけ適用されます
 * @default false
 * @type boolean
 *
 * @param sceneStatus
 * @desc ステータスシーンの背景にぼかし処理をかけるか
 * ※マップ画面からスクリプトなどで直接遷移した時だけ適用されます
 * @default false
 * @type boolean
 *
 * @param sceneOptions
 * @desc マップシーンから遷移する設定シーンの背景にぼかし処理をかけるか
 * ※マップ画面からスクリプトなどで直接遷移した時だけ適用されます
 * @default false
 * @type boolean
 *
 * @param sceneSave
 * @desc セーブシーンの背景にぼかし処理をかけるか
 * ※マップ画面からスクリプトなどで直接遷移した時だけ適用されます
 * @default false
 * @type boolean
 *
 * @param sceneOthers
 * @desc その他のシーンの背景にぼかし処理をかけるか
 * ※プラグインで新しいシーンを追加した時に使用してください
 * @default false
 * @type boolean
 *
 * @help アイテムシーンやスキルシーンの背景（マップ画面のスナップショット）
 * にぼかし処理をかけないようにします。
 * 各シーンに対応したプラグインパラメータをfalseにすると、
 * ぼかし処理を消すことができます。
 *
 * マップからではなくメニューから遷移したシーンの背景は
 * デフォルトと同様にメニューシーンの背景と同じ画像になります。
 * 
 * 新しく追加されたシーンの背景のぼかし処理をなくしたいときは、
 * プラグインパラメータ；sceneOthers(その他のシーン)をfalseにしてください。
 *
 */

(function () {

    'use strict'
    var pluginName = 'IZ_NonBlurBG';


    //■プラグインパラメータ
    var parameters = PluginManager.parameters('IZ_NonBlurBG');
    var sceneMenuBlur = Boolean(parameters['sceneMenu'] === 'true');
    var sceneItemBlur = Boolean(parameters['sceneItem'] === 'true');
    var sceneSkillBlur = Boolean(parameters['sceneSkill'] === 'true');
    var sceneEquipBlur = Boolean(parameters['sceneEquip'] === 'true');
    var sceneStatusBlur = Boolean(parameters['sceneStatus'] === 'true');
    var sceneOptionsBlur = Boolean(parameters['sceneOptions'] === 'true');
    var sceneSaveBlur = Boolean(parameters['sceneSave'] === 'true');
    var sceneOthersBlur = Boolean(parameters['sceneOthers'] === 'true');


    SceneManager.snapForBackgroundNonBlur = function () {
        this._backgroundBitmap = this.snap();
    };

    var _Scene_Map_terminate = Scene_Map.prototype.terminate;
    Scene_Map.prototype.terminate = function () {
        Scene_Base.prototype.terminate.call(this);
        if (!SceneManager.isNextScene(Scene_Battle)) {
            this._spriteset.update();
            this._mapNameWindow.hide();

            var blur = false;
            if (SceneManager.isNextScene(Scene_Menu) && sceneMenuBlur) {
                blur = true;
            } else if (SceneManager.isNextScene(Scene_Item) && sceneItemBlur) {
                blur = true;
            } else if (SceneManager.isNextScene(Scene_Equip) && sceneEquipBlur) {
                blur = true;
            } else if (SceneManager.isNextScene(Scene_Status) && sceneStatusBlur) {
                blur = true;
            } else if (SceneManager.isNextScene(Scene_Options) && sceneOptionBlur) {
                blur = true;
            } else if (SceneManager.isNextScene(Scene_Save) && sceneSaveBlur) {
                blur = true;
            } else if(sceneOthersBlur){
                blur = true;
            }

            if(blur){
                SceneManager.snapForBackground();
            }else{
                SceneManager.snapForBackgroundNonBlur();
            }

        } else {
            ImageManager.clearRequest();
        }

        if (SceneManager.isNextScene(Scene_Map)) {
            ImageManager.clearRequest();
        }

        $gameScreen.clearZoom();

        this.removeChild(this._fadeSprite);
        this.removeChild(this._mapNameWindow);
        this.removeChild(this._windowLayer);
        this.removeChild(this._spriteset);
    };




})();
